addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

const routes = {
  // production
  "d.hi2.us.kg": dockerHub,
  // "quay.libcuda.so": "https://quay.io",
  // "gcr.libcuda.so": "https://gcr.io",
  // "k8s-gcr.libcuda.so": "https://k8s.gcr.io",
  // "k8s.libcuda.so": "https://registry.k8s.io",
  "ghcr.hi2.us.kg": "https://ghcr.io",
  // "cloudsmith.libcuda.so": "https://docker.cloudsmith.io",
  // "ecr.libcuda.so": "https://public.ecr.aws",

  // staging
  // "docker-staging.libcuda.so": dockerHub,
};

const dockerRegistries = {
  // production
  "docker.io": dockerHub,
  // "quay.libcuda.so": "https://quay.io",
  // "gcr.libcuda.so": "https://gcr.io",
  // "k8s-gcr.libcuda.so": "https://k8s.gcr.io",
  // "k8s.libcuda.so": "https://registry.k8s.io",
  "ghcr.io": "https://ghcr.io",
  // "cloudsmith.libcuda.so": "https://docker.cloudsmith.io",
  // "ecr.libcuda.so": "https://public.ecr.aws",

  // staging
  // "docker-staging.libcuda.so": dockerHub,
};

// const dockerRegistriesAuth = {
//   // production
//   "docker.io": 'https://',
//   // "quay.libcuda.so": "https://quay.io",
//   // "gcr.libcuda.so": "https://gcr.io",
//   // "k8s-gcr.libcuda.so": "https://k8s.gcr.io",
//   // "k8s.libcuda.so": "https://registry.k8s.io",
//   "ghcr.io": "https://ghcr.io",
//   // "cloudsmith.libcuda.so": "https://docker.cloudsmith.io",
//   // "ecr.libcuda.so": "https://public.ecr.aws",

//   // staging
//   // "docker-staging.libcuda.so": dockerHub,
// };

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let upstream = routeByHosts(url.hostname);
  if (upstream === "") {
    return new Response(
      JSON.stringify({
        routes: routes,
      }),
      {
        status: 404,
      }
    );
  }
  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    // check if need to authenticate
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    if (resp.status === 401) {
      if (MODE == "debug") {
        headers.set(
          "Www-Authenticate",
          `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
        );
      } else {
        headers.set(
          "Www-Authenticate",
          `Bearer realm="${url.protocol}//${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
        );
      }
      return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
        status: 401,
        headers: headers,
      });
    } else {
      return resp;
    }
  }
  // get token
  if (url.pathname == "/v2/auth") {
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
        if (imageFullnameParts.length == 1) {
          imageFullnameParts.unshift('library')
        }
        scopeParts[1] = imageFullnameParts.join('/');
        scope = scopeParts.join(":");
      }
    }



    const newUrl = new URL(dockerRegistries[registry] + "/v2/");
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
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  const pathParts = url.pathname.split("/");
  if (url.pathname.startsWith('/v2/') && ['manifests', 'blobs'].includes(pathParts[pathParts.length - 2])) {
    let registry = 'docker.io'
    if (pathParts[2] in dockerRegistries) {
      registry = pathParts[2]
      pathParts.splice(2, 1)
    }
    if (pathParts.length === 5) {
      pathParts.splice(2, 0, 'library')
    }
    upstream = dockerRegistries[registry]
    requestTarget = pathParts.join('/')
  }
  // console.log('requestTarget: ' + requestTarget)
  // if (isDockerHub) {

  //   if (pathParts.length == 5) {
  //     pathParts.splice(2, 0, "library");
  //     const redirectUrl = new URL(url);
  //     redirectUrl.pathname = pathParts.join("/");
  //     return Response.redirect(redirectUrl, 301);
  //   }
  // }
  // foward requests
  // console.log('final url: ' + upstream + requestTarget)
  const newHeaders = new Headers(request.headers)
  newHeaders.delete('host')
  const newUrl = new URL(upstream + requestTarget);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: newHeaders,
    redirect: "follow",
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
