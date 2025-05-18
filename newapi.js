// --- 配置区域 ---
// 目标 API 的基础 URL
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
      // 如果您的 API 不需要 WebSocket，您可以移除或注释掉此部分和 handleWebSocket 函数
      log('INFO', `WebSocket upgrade request for: ${originalUrl.pathname}`);
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
    basePath = basePath.slice(0, -1); // 移除末尾的 '/'
  }
  let requestPath = originalUrl.pathname;
  if (!requestPath.startsWith('/')) {
    requestPath = '/' + requestPath;
  }
  // 如果 TARGET_BASE_URL 已经包含了路径 (例如 /api), 并且原始请求也是 /api/users
  // 我们需要避免路径重复，例如 /api/api/users。
  // 这里的逻辑假设 TARGET_BASE_URL 的路径是前缀，原始请求的路径是后缀。
  // 如果 TARGET_BASE_URL 本身就是根路径 ("https://example.com/")，则 basePath 为 ""。
  const targetPath = basePath + requestPath;

  const targetUrl = new URL(targetPath, TARGET_BASE_URL); // 使用 URL 构造函数正确处理路径合并
  targetUrl.search = originalUrl.search; // 复制查询参数

  log('INFO', `HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 准备新的请求头
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Host', TARGET_HOSTNAME); // 关键：将 Host 头设置为目标服务器的主机名
  requestHeaders.set('X-Forwarded-Host', originalUrl.hostname);
  requestHeaders.set('X-Forwarded-Proto', originalUrl.protocol.slice(0, -1));
  const clientIp = request.headers.get('CF-Connecting-IP'); // Cloudflare 提供的客户端真实 IP
  if (clientIp) {
    requestHeaders.set('X-Forwarded-For', clientIp);
  }

  // 清理一些 Cloudflare 特有的、不应发送到源的头部
  ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop', 'x-real-ip'].forEach(h => requestHeaders.delete(h));

  // 如果您的 API 对 User-Agent 或 Origin 敏感，您可能需要在此处添加特定的修改逻辑
  // 例如: requestHeaders.set('User-Agent', 'MyCustomProxy/1.0');
  // 例如: requestHeaders.set('Origin', TARGET_URL_PARSED.origin); // 谨慎设置 Origin

  // --- 缓存策略 (示例，仅对 GET 请求且源服务器允许缓存时) ---
  // 注意：API 代理的缓存需要非常小心，确保不会缓存动态或私有数据
  const cache = caches.default;
  let response;

  if (request.method === 'GET') {
    try {
      const cachedResponse = await cache.match(request.clone()); // 尝试从缓存中获取
      if (cachedResponse) {
        log('INFO', `Cache hit for: ${request.url}`);
        // 可以选择性地为缓存命中的响应添加一个头部，方便调试
        // const newCachedHeaders = new Headers(cachedResponse.headers);
        // newCachedHeaders.set('X-Worker-Cache', 'HIT');
        // return new Response(cachedResponse.body, { ...cachedResponse, headers: newCachedHeaders });
        return cachedResponse;
      }
      log('INFO', `Cache miss for: ${request.url}`);
    } catch (cacheError) {
      log('WARN', 'Cache API match error (continuing without cache):', cacheError.message);
    }
  } else {
    log('INFO', `Non-GET request or cache disabled for method: ${request.method}`);
  }


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
    // 根据您的需求调整这些 CORS 设置
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', requestOrigin); // 动态允许请求来源
      responseHeaders.set('Vary', 'Origin'); // 告知缓存，响应随 Origin 头变化
    } else {
      // 如果没有 Origin 请求头 (例如非浏览器请求)，可以允许所有或特定配置的来源
      // 为了安全，最好不要默认设置为 '*'，除非您确定 API 是完全公开的
      responseHeaders.set('Access-Control-Allow-Origin', '*'); // 或者更严格的默认值, 例如 TARGET_URL_PARSED.origin
    }
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    // 允许客户端发送的头部，根据需要添加
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept, Origin, X-Requested-With, X-Custom-Header, Your-Specific-Header');
    // 允许客户端访问的头部
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Date, ETag, Vary, Your-Specific-Header');

    // 如果需要凭据 (例如 cookies, Authorization header)，Access-Control-Allow-Origin 不能是 '*'
    // 并且需要设置 Access-Control-Allow-Credentials 为 'true'
    if (responseHeaders.get('Access-Control-Allow-Origin') !== '*') {
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }


    // --- OPTIONS 请求预检处理 ---
    if (request.method === 'OPTIONS') {
      // 已经添加了上述 CORS 头部
      log('INFO', `Handling OPTIONS preflight for: ${originalUrl.pathname}`);
      return new Response(null, {
        status: 204, // No Content
        headers: responseHeaders,
      });
    }

    // --- 处理源服务器的重定向响应 ---
    if (originResponse.status >= 300 && originResponse.status < 400 && responseHeaders.has('location')) {
      const location = responseHeaders.get('location');
      log('INFO', `Redirecting: ${originResponse.status} from ${targetUrl.toString()} to ${location}`);
      // 通常直接透传。如果需要修改 location URL（例如，从内部域名到公共域名），可以在此处理
      // 例如，如果 location 是相对路径，需要转换为绝对路径
      // const newLocation = new URL(location, targetUrl).toString();
      // responseHeaders.set('location', newLocation);
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders, // 包含原始或修改后的 location
      });
    }

    // --- 添加基础的安全响应头 (如果源服务器没有提供的话) ---
    if (!responseHeaders.has('X-Content-Type-Options')) responseHeaders.set('X-Content-Type-Options', 'nosniff');
    if (!responseHeaders.has('X-Frame-Options')) responseHeaders.set('X-Frame-Options', 'DENY');
    // CSP 策略需要根据您的 API 内容仔细配置，此处仅为示例，且默认注释掉
    // if (!responseHeaders.has('Content-Security-Policy')) responseHeaders.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none';");
    responseHeaders.delete('X-Powered-By'); // 移除可能的后端技术指纹


    // --- 缓存响应 (示例，仅对 GET 请求且源服务器指示可缓存时) ---
    if (request.method === 'GET' && originResponse.ok) {
      // 检查源服务器是否允许缓存 (例如通过 Cache-Control 头部)
      const cacheControl = originResponse.headers.get('Cache-Control');
      const pragma = originResponse.headers.get('Pragma'); // HTTP/1.0 兼容
      const expires = originResponse.headers.get('Expires');

      const canCache = cacheControl &&
                       !cacheControl.includes('no-cache') &&
                       !cacheControl.includes('no-store') &&
                       !cacheControl.includes('private') &&
                       pragma !== 'no-cache';
                       // 也可以检查 expires 头部

      if (canCache) {
        log('INFO', `Response eligible for caching: ${request.url}. Cache-Control: ${cacheControl}`);
        // 克隆响应用于缓存，因为响应体只能使用一次
        const responseToCache = originResponse.clone();
        // 异步写入缓存，不阻塞对客户端的响应
        // 注意: ctx.waitUntil 仅在请求的顶层作用域有效，如果在这里的 try/catch 中，
        // 并且希望确保缓存写入完成，可能需要更复杂的处理或移到顶层。
        // 对于简单场景，直接调用 cache.put 通常也可以。
        ctx.waitUntil(cache.put(request.clone(), responseToCache));
      } else {
        log('INFO', `Response not eligible for caching or caching disabled for: ${request.url}. Cache-Control: ${cacheControl}, Pragma: ${pragma}`);
      }
    }
    
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    log('ERROR', `CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}. URL: ${targetUrl.toString()}`, e.stack);
    // 返回一个自定义的错误响应给客户端
    return new Response(`代理错误: 无法连接到目标服务。(${e.message})`, {
      status: 502, // Bad Gateway
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// --- WebSocket 请求处理函数 ---
// 如果您的 API 不需要 WebSocket，可以安全地移除此函数和 fetch 处理程序中的相关逻辑
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
  targetUrl.protocol = TARGET_SCHEME === 'https' ? 'wss' : 'ws'; // 切换到 ws 或 wss

  log('INFO', `WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 创建 WebSocket 对。一个连接到客户端，一个连接到源服务器。
  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0]; // Worker <-> Client
  const serverWs = webSocketPair[1]; // Worker <-> Origin

  // Worker 接受来自客户端的 WebSocket 连接
  serverWs.accept();

  // 准备发往源服务器的 WebSocket 请求头
  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOSTNAME);
  originWsHeaders.set('Upgrade', 'websocket'); // 必须
  originWsHeaders.set('Connection', 'Upgrade'); // 必须

  // 透传必要的或推荐的 WebSocket 头部
  // 注意：不是所有头部都可以或应该被客户端设置并透传
  const headersToForward = [
    'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol',
    'User-Agent', 'Origin', // Origin 对跨域 WebSocket 很重要
    // 'Cookie', 'Authorization' // 根据需要透传 Cookie 和 Authorization，注意安全风险
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
    // 尝试与源服务器建立 WebSocket 连接
    const originResponse = await fetch(targetUrl.toString(), {
      headers: originWsHeaders,
    });

    const originSocket = originResponse.webSocket;
    if (!originSocket) {
      // 如果源服务器没有返回一个 WebSocket 对象 (例如，返回了非 101 状态码)
      log('ERROR', `WebSocket origin did not upgrade. Status: ${originResponse.status} ${originResponse.statusText}. URL: ${targetUrl.toString()}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originResponse.status} ${originResponse.statusText}.`;
      try { errorBody += " Body: " + await originResponse.text(); } catch (e) {}
      // 关闭与客户端的 WebSocket 连接
      serverWs.close(1011, "Origin server did not upgrade to WebSocket");
      // 返回源服务器的错误响应给客户端 (如果它是 HTTP 错误)
      return new Response(errorBody, { status: originResponse.status, headers: originResponse.headers });
    }

    // 源服务器成功升级，现在接受它
    originSocket.accept();

    // 双向绑定消息、关闭、错误事件，实现数据透传
    originSocket.addEventListener('message', event => {
      try {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      } catch (e) { log('ERROR', `Error serverWs.send: ${e.message}`, e.stack); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log('ERROR', `Error originSocket.send: ${e.message}`, e.stack); }
    });

    const commonCloseOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || (type === 'error' ? 1011 : 1000); // 1011: Internal Error
      const reason = event.reason || (type === 'error' ? `WebSocket error on ${wsSide}` : `WebSocket connection closed on ${wsSide}`);
      log('INFO', `${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
      // 如果另一端仍然打开，则关闭它
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'close'));
    serverWs.addEventListener('close', event => commonCloseOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'error'));
    serverWs.addEventListener('error', event => commonCloseOrErrorHandler('Client', originSocket, event, 'error'));
    
    // 准备返回给客户端的 101 Switching Protocols 响应
    const responseHeaders = new Headers();
    // 如果源服务器协商了子协议，将其透传给客户端
    if (originResponse.headers.has('sec-websocket-protocol')) {
      responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
    }

    return new Response(null, {
      status: 101, // Switching Protocols
      webSocket: clientWs, // 将客户端的 WebSocket 端点返回给运行时
      headers: responseHeaders, // 包含协商的子协议等
    });

  } catch (error) {
    log('ERROR', `WebSocket connection to origin error: ${error.name} - ${error.message}`, error.stack);
    // 如果在连接到源的过程中发生错误 (例如 fetch 失败)
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
      serverWs.close(1011, `Proxy to origin WebSocket failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, {
      status: 502, // Bad Gateway
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
