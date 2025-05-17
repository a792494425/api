export default {
  async fetch(request) {
    const targetBaseUrl = "https://dondxjpjwzow.ap-northeast-1.clawcloudrun.com/";
    const originalUrl = new URL(request.url);

    // 构建指向目标服务器的完整 URL
    // 使用原始请求的路径和查询参数
    const targetUrl = new URL(targetBaseUrl);
    targetUrl.pathname = originalUrl.pathname;
    targetUrl.search = originalUrl.search;

    // 创建一个新的请求对象，用于发往目标服务器
    // 复制原始请求的方法、大部分头部和请求体
    const newHeaders = new Headers(request.headers);

    // 非常重要：将 Host 头部设置为目标服务器的域名
    newHeaders.set('Host', targetUrl.hostname);

    // 你可以根据需要添加或修改其他头部
    // 例如，Cloudflare 会自动添加 CF-Connecting-IP 作为客户端真实 IP
    // newHeaders.set('X-My-Custom-Header', 'SomeValue');

    let response;
    try {
      response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined, // GET/HEAD 请求不应有 body
        redirect: 'manual', // 对于代理，通常手动处理重定向或让它们通过
      });

      // 为了能够修改响应头（例如添加CORS头），我们需要重新创建一个Response对象
      const responseHeaders = new Headers(response.headers);

      // 示例：如果需要，在这里添加 CORS 头部
      // 请谨慎使用通配符 "*" ，根据实际情况配置
      // responseHeaders.set('Access-Control-Allow-Origin', '*');
      // responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      // responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      // 如果原始响应是重定向，并且你想让客户端处理它
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        // 可以直接返回原始重定向，或者修改 location (如果代理本身在不同路径下)
        // 对于简单反代，直接返回通常没问题
        return new Response(null, {
            status: response.status,
            headers: responseHeaders // 包含 location 的头部
        });
      }
      
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

    } catch (e) {
      // 如果代理请求失败
      console.error('CF Worker Proxy fetch error:', e);
      return new Response('Proxy error: Could not connect to target service.', { status: 502 });
    }

    return response;
  },
};
