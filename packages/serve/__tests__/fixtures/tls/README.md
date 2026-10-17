# Test-only TLS fixture

Self-signed certificate for `gateway.tls.test.ts`.

- `localhost-cert.pem` / `localhost-key.pem`
- SAN: `DNS:localhost`, `IP:127.0.0.1`
- Generated for offline tests only. Never used at runtime, never referenced by the gateway
  or any published package.
- Public key material only; the private key is a throwaway test key.

Regenerate with:

```bash
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 36500 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
