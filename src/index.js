addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

const dockerRegistries = {
  "docker.io": dockerHub,
  "ghcr.io": "https://ghcr.io",
  "nixery.dev": "https://nixery.dev",
  "quay.io": "https://quay.io",
  "gcr.io": "https://gcr.io",
  "docker.cloudsmith.io": "https://docker.cloudsmith.io",
  "public.ecr.aws": "https://public.ecr.aws",
  "registry.ollama.ai": "https://registry.ollama.ai",
};

async function handleRequest(request) {
  const url = new URL(request.url);
  let upstream = dockerHub
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    const headers = new Headers();
    headers.set(
      "Www-Authenticate",
      `Bearer realm="${url.protocol}//${url.hostname}/token",service="cloudflare-docker-proxy"`
    );
    return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
      status: 401,
      headers: headers,
    });
  }
  // get token
  if (url.pathname === "/token") {
    let scope = url.searchParams.get("scope");
    let registry = 'docker.io'
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3) {
        const imageFullname = scopeParts[1];
        const imageFullnameParts = imageFullname.split('/')
        if (imageFullnameParts[0] in dockerRegistries) {
          // default registry
          registry = imageFullnameParts[0]
          imageFullnameParts.shift()
        }
        if (registry !== 'nixery.dev' && imageFullnameParts.length == 1) {
          imageFullnameParts.unshift('library')
        }
        scopeParts[1] = imageFullnameParts.join('/');
        scope = scopeParts.join(":");
      }
    }

    const newUrl = new URL(registry !== 'nixery.dev' ? dockerRegistries[registry] : dockerRegistries['docker.io'] + "/v2/");
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    if (resp.status !== 401) {
      return resp;
    }
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  let requestTarget = url.pathname
  let requestMethod = request.method
  // redirect for registry image and DockerHub library images
  // Example: /v2/ghcr.io/busybox/manifests/latest => https://ghcr.io/v2/library/busybox/manifests/latest
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  const pathParts = url.pathname.split("/");
  if (url.pathname.startsWith('/v2/') && ['manifests', 'blobs'].includes(pathParts[pathParts.length - 2])) {
    let registry = 'docker.io'
    const userAgent = request.headers.get('user-agent')
    if (userAgent.includes('ollama')) {
      registry = 'registry.ollama.ai'
      requestMethod = 'GET'
    } else if (pathParts[2] in dockerRegistries) {
      registry = pathParts[2]
      pathParts.splice(2, 1)
    }

    if (registry !== 'nixery.dev' && pathParts.length === 5) {
      pathParts.splice(2, 0, 'library')
    }
    upstream = dockerRegistries[registry]
    requestTarget = pathParts.join('/')
  }
  const newUrl = new URL(upstream + requestTarget);
  const newReq = new Request(newUrl, {
    method: requestMethod,
    headers: request.headers,
    redirect: "manual",
  });
  return await fetch(newReq);
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}
