// --- 配置区域 ---
const TARGET_BASE_URL = "https://dondxjpjwzow.ap-northeast-1.clawcloudrun.com";
// 从 TARGET_BASE_URL 自动提取协议和主机名
const TARGET_URL_PARSED = new URL(TARGET_BASE_URL);
const TARGET_SCHEME = TARGET_URL_PARSED.protocol.slice(0, -1); // 'http' or 'https'
const TARGET_HOSTNAME = TARGET_URL_PARSED.hostname;

// --- 日志记录函数 (可选，用于调试) ---
function log(level, message, data = '') {
  // 在 Cloudflare Workers 中，可以直接使用 console.log, console.error 等
  // 对于生产环境，您可能希望将日志发送到第三方日志服务
  const logMessage = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage, data) : console.log(logMessage, data);
  } else {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage) : console.log(logMessage);
  }
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
    const originalUrl = new URL(request.url);

    // 判断是否为 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      // 如果 "newapi" 明确不需要 WebSocket，您可以移除或注释掉此部分和 handleWebSocket 函数
      return handleWebSocket(request, originalUrl, ctx, env);
    } else {
      // 处理普通的 HTTP/HTTPS 请求
      return handleHttpRequest(request, originalUrl, ctx, env);
    }
  },
};

// --- HTTP/HTTPS 请求处理函数 ---
async function handleHttpRequest(request, originalUrl, ctx, env) {
  // 构建指向目标服务器的完整 URL
  // 确保正确合并 TARGET_BASE_URL 的路径部分和客户端请求的路径
  let basePath = TARGET_URL_PARSED.pathname;
  if (basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }
  let requestPath = originalUrl.pathname;
  if (!requestPath.startsWith('/')) {
    requestPath = '/' + requestPath;
  }
  const targetPath = basePath + requestPath;

  const targetUrl = new URL(targetPath, TARGET_BASE_URL); // 使用 URL 构造函数正确处理路径合并
  targetUrl.search = originalUrl.search; // 复制查询参数

  log('INFO', `HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 准备新的请求头
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Host', TARGET_HOSTNAME);
  // 添加 X-Forwarded-* 头部，让后端了解原始请求信息
  requestHeaders.set('X-Forwarded-Host', originalUrl.hostname);
  requestHeaders.set('X-Forwarded-Proto', originalUrl.protocol.slice(0, -1));
  const clientIp = request.headers.get('CF-Connecting-IP'); // Cloudflare 提供的客户端真实 IP
  if (clientIp) {
    requestHeaders.set('X-Forwarded-For', clientIp);
  }

  // 清理一些 Cloudflare 特有的、不应发送到源的头部
  ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop', 'x-real-ip'].forEach(h => requestHeaders.delete(h));

  // 如果 "newapi" 对 User-Agent 或 Origin 敏感，您可能需要在此处添加特定的修改逻辑
  // 例如: requestHeaders.set('User-Agent', 'MyCustomProxy/1.0');
  // 例如: requestHeaders.set('Origin', TARGET_URL_PARSED.origin);

  // --- 缓存策略 (示例，仅对 GET 请求且源服务器允许缓存时) ---
  // 注意：API 代理的缓存需要非常小心，确保不会缓存动态或私有数据
  const cache = caches.default;
  let response;

  if (request.method === 'GET') {
    try {
      response = await cache.match(request.clone()); // 尝试从缓存中获取
    } catch (cacheError) {
      log('WARN', 'Cache API match error (continuing without cache):', cacheError.message);
    }
  }

  if (response) {
    log('INFO', `Cache hit for: ${request.url}`);
    // 可以选择性地为缓存命中的响应添加一个头部，方便调试
    // const cachedResponseHeaders = new Headers(response.headers);
    // cachedResponseHeaders.set('X-Worker-Cache', 'HIT');
    // return new Response(response.body, { ...response, headers: cachedResponseHeaders });
    return response;
  }
  log('INFO', `Cache miss or non-GET for: ${request.url}`);

  try {
    const originResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual', // 代理将重定向传递给客户端处理
    });

    // 复制响应头以便修改
    let responseHeaders = new Headers(originResponse.headers);

    // --- CORS 头部处理 ---
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', requestOrigin);
      responseHeaders.set('Vary', 'Origin');
    } else {
      // 如果没有 Origin 请求头 (例如非浏览器请求)，可以允许所有或特定配置的来源
      responseHeaders.set('Access-Control-Allow-Origin', '*'); // 或更严格的默认值
    }
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept, Origin, X-Requested-With, X-Custom-Header'); // 增加常见头部
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Date, ETag, Vary'); // 暴露一些常用头部
    // 如果需要凭据，Access-Control-Allow-Origin 不能是 '*'
    if (responseHeaders.get('Access-Control-Allow-Origin') !== '*') {
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }


    // --- OPTIONS 请求预检处理 ---
    if (request.method === 'OPTIONS') {
      // 已经添加了上述 CORS 头部
      return new Response(null, {
        status: 204, // No Content
        headers: responseHeaders,
      });
    }

    // --- 处理源服务器的重定向响应 ---
    if (originResponse.status >= 300 && originResponse.status < 400 && responseHeaders.has('location')) {
      const location = responseHeaders.get('location');
      log('INFO', `Redirecting: ${originResponse.status} to ${location}`);
      // 通常直接透传，如果需要修改 location URL（例如，从内部域名到公共域名），可以在此处理
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders,
      });
    }

    // --- 添加基础的安全响应头 (如果源服务器没有提供的话) ---
    if (!responseHeaders.has('X-Content-Type-Options')) responseHeaders.set('X-Content-Type-Options', 'nosniff');
    if (!responseHeaders.has('X-Frame-Options')) responseHeaders.set('X-Frame-Options', 'DENY');
    // CSP 策略需要根据 "newapi" 的内容仔细配置，此处仅为示例
    // if (!responseHeaders.has('Content-Security-Policy')) responseHeaders.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none';");
    responseHeaders.delete('X-Powered-By'); // 移除可能的后端技术指纹


    // --- 缓存响应 (示例，仅对 GET 请求且源服务器指示可缓存时) ---
    if (request.method === 'GET' && originResponse.ok) {
      // 检查源服务器是否允许缓存 (例如通过 Cache-Control 头部)
      const cacheControl = originResponse.headers.get('Cache-Control');
      const pragma = originResponse.headers.get('Pragma');
      if (cacheControl && !cacheControl.includes('no-cache') && !cacheControl.includes('no-store') && !cacheControl.includes('private') &&
          pragma !== 'no-cache') {
        // 克隆响应用于缓存，因为响应体只能使用一次
        const responseToCache = originResponse.clone();
        // 异步写入缓存，不阻塞对客户端的响应
        ctx.waitUntil(cache.put(request.clone(), responseToCache));
        log('INFO', `Response eligible for caching: ${request.url}`);
      }
    }
    
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    log('ERROR', `CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}. URL: ${targetUrl.toString()}`, e.stack);
    return new Response(`Proxy error: Could not connect to target service. (${e.message})`, { status: 502 });
  }
}

// --- WebSocket 请求处理函数 ---
async function handleWebSocket(request, originalUrl, ctx, env) {
  let basePath = TARGET_URL_PARSED.pathname;
  if (basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }
  let requestPath = originalUrl.pathname;
  if (!requestPath.startsWith('/')) {
    requestPath = '/' + requestPath;
  }
  const targetPath = basePath + requestPath;

  const targetUrl = new URL(targetPath, TARGET_BASE_URL);
  targetUrl.search = originalUrl.search;
  targetUrl.protocol = TARGET_SCHEME === 'https' ? 'wss' : 'ws';

  log('INFO', `WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0];
  const serverWs = webSocketPair[1];

  serverWs.accept();

  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOSTNAME);
  originWsHeaders.set('Upgrade', 'websocket');

  // 透传必要的或推荐的头部
  const headersToForward = [
    'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol',
    'User-Agent', 'Origin', 'Cookie', 'Authorization' // Cookie 和 Auth 根据需要
  ];
  for (const headerName of headersToForward) {
    if (request.headers.has(headerName)) {
      originWsHeaders.set(headerName, request.headers.get(headerName));
    }
  }
  // 如果客户端未发送 Origin，但目标服务需要，可以考虑在此处设置一个默认的 Origin:
  // if (!originWsHeaders.has('Origin') && TARGET_URL_PARSED.origin !== 'null') {
  //   originWsHeaders.set('Origin', TARGET_URL_PARSED.origin);
  // }


  try {
    const originResponse = await fetch(targetUrl.toString(), {
      headers: originWsHeaders,
    });

    const originSocket = originResponse.webSocket;
    if (!originSocket) {
      log('ERROR', `WebSocket origin did not upgrade. Status: ${originResponse.status}. URL: ${targetUrl.toString()}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originResponse.status}.`;
      try { errorBody += " Body: " + await originResponse.text(); } catch (e) {}
      serverWs.close(1011, "Origin did not upgrade to WebSocket");
      return new Response(errorBody, { status: originResponse.status, headers: originResponse.headers });
    }

    originSocket.accept();

    // 双向绑定消息、关闭、错误事件
    originSocket.addEventListener('message', event => {
      try {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      } catch (e) { log('ERROR', `Error serverWs.send: ${e}`, e.stack); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log('ERROR', `Error originSocket.send: ${e}`, e.stack); }
    });

    const commonCloseOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || (type === 'error' ? 1011 : 1000);
      const reason = event.reason || (type === 'error' ? `WebSocket error on ${wsSide}` : `WebSocket connection closed on ${wsSide}`);
      log('INFO', `${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'close'));
    serverWs.addEventListener('close', event => commonCloseOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'error'));
    serverWs.addEventListener('error', event => commonCloseOrErrorHandler('Client', originSocket, event, 'error'));
    
    const responseHeaders = new Headers();
    if (originResponse.headers.has('sec-websocket-protocol')) {
        responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: responseHeaders,
    });

  } catch (error) {
    log('ERROR', `WebSocket connection to origin error: ${error.name} - ${error.message}`, error.stack);
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
        serverWs.close(1011, `Proxy to origin failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 });
  }
}

