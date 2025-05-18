// --- 配置区域 ---
// 目标 API 的基础 URL
// 重要提示：如果您的 targetBaseUrlString 包含路径 (例如 https://api.example.com/v1)，
// 此脚本中的路径处理逻辑能够正确地将其与请求路径合并。
const TARGET_BASE_URL_STRING = "https://dondxjpjwzow.ap-northeast-1.clawcloudrun.com";

// --- 日志记录函数 (可选，用于调试) ---
function log(level, message, data = '') {
  const logMessage = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (data && typeof data === 'object') {
    try {
      data = JSON.stringify(data);
    } catch (e) {
      // Fallback if data cannot be stringified
    }
  }
  if (data) {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage, data) : console.log(logMessage, data);
  } else {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage) : console.log(logMessage);
  }
}

export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
    const originalUrl = new URL(request.url);
    const parsedTargetBase = new URL(TARGET_BASE_URL_STRING);

    // --- 构造目标 URL (更健壮的路径合并) ---
    // 此逻辑会正确处理 TARGET_BASE_URL_STRING 中可能存在的路径。
    let basePath = parsedTargetBase.pathname;
    // 如果 TARGET_BASE_URL_STRING 只是一个域名 (例如 "https://api.example.com")，其 pathname 通常是 "/"
    // 在这种情况下，我们不希望将这个 "/" 作为路径前缀。
    if (basePath === '/') {
      basePath = '';
    }
    // 移除 basePath 可能存在的末尾斜杠，以避免与 requestPath 的起始斜杠重复导致 "//"
    if (basePath.endsWith('/')) {
      basePath = basePath.slice(0, -1);
    }

    let requestPath = originalUrl.pathname; // 例如 "/mj/submit/imagine"

    // 最终路径是 basePath 和 requestPath 的组合
    const finalPath = basePath + requestPath;

    const targetUrl = new URL(finalPath, parsedTargetBase.origin); // 使用目标源的 origin 和新构造的完整路径
    targetUrl.search = originalUrl.search; // 复制查询参数

    log('INFO', `Proxying: ${request.method} ${originalUrl.href} -> ${targetUrl.href}`);

    // --- 准备请求头 ---
    const requestHeaders = new Headers(request.headers);

    // 关键: 将 Host 头部设置为目标服务器的主机名
    requestHeaders.set('Host', parsedTargetBase.hostname);

    // 添加 X-Forwarded-* 头部，让后端了解原始请求信息
    requestHeaders.set('X-Forwarded-Host', originalUrl.hostname);
    requestHeaders.set('X-Forwarded-Proto', originalUrl.protocol.slice(0, -1));
    const clientIp = request.headers.get('CF-Connecting-IP'); // Cloudflare 提供的客户端真实 IP
    if (clientIp) {
      requestHeaders.set('X-Forwarded-For', clientIp);
    }

    // (可选) 清理一些 Cloudflare 特有的、通常不应发送到源服务器的头部
    ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop', 'x-real-ip'].forEach(h => requestHeaders.delete(h));

    // --- 执行代理请求 ---
    let originResponse;
    try {
      originResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: requestHeaders,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
        redirect: 'manual', // 代理通常手动处理重定向或直接透传
      });

      // 复制响应头以便修改（例如添加 CORS 头）
      const responseHeaders = new Headers(originResponse.headers);

      // --- CORS 头部处理 (可选，根据需要取消注释和调整) ---
      // 注意：如果启用，请仔细配置允许的源、方法和头部。
      /*
      const requestOrigin = request.headers.get('Origin');
      if (requestOrigin) {
        responseHeaders.set('Access-Control-Allow-Origin', requestOrigin); // 动态允许请求来源
        responseHeaders.set('Vary', 'Origin'); // 告知缓存，响应随 Origin 头变化
      } else {
        // 对于非浏览器请求或没有 Origin 的情况，可以设置一个默认值
        // responseHeaders.set('Access-Control-Allow-Origin', '*'); // 谨慎使用 '*'
      }
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept, Origin, X-Requested-With'); // 根据需要添加
      // responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Date, ETag, Vary'); // 根据需要暴露
      // if (responseHeaders.get('Access-Control-Allow-Origin') !== '*' && responseHeaders.get('Access-Control-Allow-Origin') !== null) {
      //   responseHeaders.set('Access-Control-Allow-Credentials', 'true'); // 如果需要凭据且源不是 '*'
      // }
      */

      // --- OPTIONS 预检请求处理 (与 CORS 一起启用) ---
      /*
      if (request.method === 'OPTIONS') {
        log('INFO', `Handling OPTIONS preflight for: ${originalUrl.pathname}`);
        // 确保上面的 Access-Control-Allow-* 头部已设置
        return new Response(null, {
          status: 204, // No Content
          headers: responseHeaders,
        });
      }
      */

      // --- 处理源服务器的重定向响应 ---
      if (originResponse.status >= 300 && originResponse.status < 400 && responseHeaders.has('location')) {
        log('INFO', `Redirecting: ${originResponse.status} to ${responseHeaders.get('location')}`);
        // 直接返回源服务器的重定向响应
        return new Response(null, { // 重定向响应通常没有 body
          status: originResponse.status,
          headers: responseHeaders, // 包含 location 等原始头部
        });
      }
      
      // --- 返回最终响应 ---
      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders, // 使用（可能已修改的）响应头
      });

    } catch (e) {
      log('ERROR', `CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}. URL: ${targetUrl.toString()}`, e.stack);
      // 返回一个更详细的错误响应给客户端
      return new Response(`代理错误: 无法连接到目标服务。(${e.message})`, {
        status: 502, // Bad Gateway
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  },
};
