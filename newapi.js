// --- 配置区域 ---
const TARGET_BASE_URL = "https://dondxjpjwzow.ap-northeast-1.clawcloudrun.com/";
// 从 TARGET_BASE_URL 自动提取协议 (http 或 https) 和主机名
const TARGET_URL_PARSED = new URL(TARGET_BASE_URL);
const TARGET_SCHEME = TARGET_URL_PARSED.protocol.slice(0, -1);
const TARGET_HOSTNAME = TARGET_URL_PARSED.hostname;

// --- 日志记录函数 (可选，用于调试) ---
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
    const originalUrl = new URL(request.url);

    // 判断是否为 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      // 如果 "newapi" 不需要 WebSocket，您可以移除或注释掉此部分和 handleWebSocket 函数
      return handleWebSocket(request, originalUrl);
    } else {
      // 处理普通的 HTTP/HTTPS 请求
      return handleHttpRequest(request, originalUrl);
    }
  },
};

// --- HTTP/HTTPS 请求处理函数 ---
async function handleHttpRequest(request, originalUrl) {
  // 构建指向目标服务器的完整 URL
  const targetUrl = new URL(TARGET_BASE_URL); // 使用原始 TARGET_BASE_URL 以保留其路径部分 (如果有)
  targetUrl.pathname = (TARGET_URL_PARSED.pathname.endsWith('/') ? TARGET_URL_PARSED.pathname.slice(0, -1) : TARGET_URL_PARSED.pathname) + 
                       (originalUrl.pathname.startsWith('/') ? originalUrl.pathname : '/' + originalUrl.pathname);
  targetUrl.search = originalUrl.search;


  log(`HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 准备新的请求头
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Host', TARGET_HOSTNAME); // 非常重要：设置目标服务器的 Host 头部
  requestHeaders.set('X-Forwarded-Host', originalUrl.hostname); // 告知后端最初请求的主机
  requestHeaders.set('X-Forwarded-Proto', originalUrl.protocol.slice(0, -1)); // 告知后端最初的协议

  // 清理一些 Cloudflare 特有的、不应发送到源的头部
  requestHeaders.delete('cf-connecting-ip');
  requestHeaders.delete('cf-ipcountry');
  requestHeaders.delete('cf-ray');
  requestHeaders.delete('cf-visitor');
  requestHeaders.delete('x-real-ip'); // 通常由 cf-connecting-ip 代替
  requestHeaders.delete('cdn-loop'); // 避免代理循环

  // 如果您的 "newapi" 对 User-Agent 或 Origin 敏感，您可能需要在此处添加特定的修改逻辑
  // 例如: requestHeaders.set('User-Agent', 'MyCustomUserAgent/1.0');
  // 例如: requestHeaders.set('Origin', TARGET_URL_PARSED.origin);


  let originResponse;
  try {
    originResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual', // 与您脚本中的设置一致，代理将重定向传递给客户端处理
    });

    // 复制响应头以便修改
    let responseHeaders = new Headers(originResponse.headers);

    // --- CORS 头部处理 ---
    // 谨慎配置： "*" 允许所有来源，但如果需要凭据，则不能为 "*"
    const clientOrigin = request.headers.get('Origin');
    if (clientOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', clientOrigin); // 更安全：允许请求的来源
      responseHeaders.set('Vary', 'Origin'); // 告知缓存，响应随 Origin 头部变化
    } else {
      responseHeaders.set('Access-Control-Allow-Origin', '*'); // 降级为允许所有（如果客户端未发送Origin）
    }
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    // 根据 "newapi" 实际需要的头部进行调整
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Custom-Header, Range');
    // 如果您的应用需要 cookie 或 Authorization 头部进行跨域请求
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');


    // --- OPTIONS 请求预检处理 ---
    // 如果是 OPTIONS 请求 (CORS 预检)，并且我们已经设置了上面的 CORS 头部，可以直接返回 204 No Content
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204, // No Content
        headers: responseHeaders,
      });
    }

    // --- 处理源服务器的重定向响应 ---
    if (originResponse.status >= 300 && originResponse.status < 400 && responseHeaders.has('location')) {
      const location = responseHeaders.get('location');
      // 如果 location 是相对路径，或者指向了原始的 TARGET_BASE_URL，通常不需要修改
      // 如果 location 是绝对路径且指向了其他域名，或者需要将 TARGET_BASE_URL 替换为 Worker 的 URL，则可能需要重写
      // 为简单起见，此处直接透传（大部分情况下是期望行为）
      log(`Redirecting: ${originResponse.status} to ${location}`);
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders,
      });
    }

    // --- 可选：添加一些安全相关的响应头 ---
    // responseHeaders.set('X-Content-Type-Options', 'nosniff');
    // responseHeaders.set('X-Frame-Options', 'DENY');
    // responseHeaders.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; object-src 'none';");
    // responseHeaders.delete('X-Powered-By'); // 移除后端指纹信息


    // 创建新的响应对象并返回
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    log(`CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}. URL: ${targetUrl.toString()}`);
    // 可以根据错误类型返回更具体的错误信息给客户端
    return new Response(`Proxy error: Could not connect to target service. (${e.message})`, { status: 502 }); // 502 Bad Gateway
  }
}

// --- WebSocket 请求处理函数 ---
// 如果 "newapi" 明确不需要 WebSocket，可以移除此函数和 fetch 入口处的判断
async function handleWebSocket(request, originalUrl) {
  const targetUrl = new URL(TARGET_BASE_URL);
  targetUrl.pathname = (TARGET_URL_PARSED.pathname.endsWith('/') ? TARGET_URL_PARSED.pathname.slice(0, -1) : TARGET_URL_PARSED.pathname) + 
                       (originalUrl.pathname.startsWith('/') ? originalUrl.pathname : '/' + originalUrl.pathname);
  targetUrl.search = originalUrl.search;
  targetUrl.protocol = TARGET_SCHEME === 'https' ? 'wss' : 'ws'; // 切换到 ws/wss 协议

  log(`WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0];
  const serverWs = webSocketPair[1];

  serverWs.accept();

  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOSTNAME);
  originWsHeaders.set('Upgrade', 'websocket');
  // 通常 fetch 会自动处理 Connection: Upgrade

  // 透传必要的 Sec-WebSocket-* 头部
  const requiredWsHeaders = ['Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'User-Agent', 'Origin'];
  for (const headerName of requiredWsHeaders) {
    if (request.headers.has(headerName)) {
      originWsHeaders.set(headerName, request.headers.get(headerName));
    }
  }
  // 如果客户端没有发送 Origin，但目标服务需要，可以考虑在此处设置一个默认的 Origin:
  // if (!originWsHeaders.has('Origin') && TARGET_URL_PARSED.origin !== 'null') {
  //   originWsHeaders.set('Origin', TARGET_URL_PARSED.origin);
  // }


  try {
    const originResponse = await fetch(targetUrl.toString(), {
      headers: originWsHeaders,
    });

    const originSocket = originResponse.webSocket;
    if (!originSocket) {
      log(`WebSocket origin did not upgrade. Status: ${originResponse.status}. URL: ${targetUrl.toString()}`);
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
      } catch (e) { log(`Error serverWs.send: ${e}`); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log(`Error originSocket.send: ${e}`); }
    });

    const commonCloseOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || (type === 'error' ? 1011 : 1000);
      const reason = event.reason || (type === 'error' ? 'WebSocket error on ' + wsSide : 'WebSocket connection closed on ' + wsSide);
      log(`${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
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
    log(`WebSocket connection to origin error: ${error.name} - ${error.message}`);
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
        serverWs.close(1011, `Proxy to origin failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 });
  }
}
