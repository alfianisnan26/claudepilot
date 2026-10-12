# Caddy with the Cloudflare DNS module: pilot.dev.isnan.me only resolves locally, so the certificate
# comes through a DNS-01 challenge instead of HTTP.
FROM caddy:2.10-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.10
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
