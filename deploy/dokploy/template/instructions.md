# Vectorix

The template starts the web dashboard on the main domain, the API on `api.<domain>` and the superadmin console on `admin.<domain>`, with PostgreSQL, vector PostgreSQL (pgvector and pgvectorscale), Redis and private RustFS storage.

1. **Production domain**: before importing, set `main_domain` (for example `vectorix.app`) and `scheme = "https"` in the template variables. After the first deployment, enable HTTPS with Let's Encrypt on the three domains in the _Domains_ tab. Do not host other, less trusted services under the same parent domain: the session cookie is shared across it.
2. **Registry**: the server must be able to pull `pxdv.be/vectorix/*` (`docker login pxdv.be`).
3. **CPU**: on x86 servers, vector PostgreSQL requires AVX2 and FMA.
4. **Mail and embeddings**: fill a Resend key or SMTP settings (password reset and email verification), and at least one embedding provider key, or let each organization configure its own in the dashboard.
5. **First superadmin**: sign up on the main domain, then run in the `postgres` container: `psql -U vectorix -d vectorix -c "UPDATE \"user\" SET \"isSuperAdmin\" = true WHERE email = 'you@example.com';"`
6. **Back up `ENCRYPTION_SECRET`** outside the server, together with the two databases and the RustFS volume.

Set `VECTORIX_TRUSTED_PROXIES` to the subnet of `dokploy-network` so authentication rate limits see real client addresses (images built from commit `76ca3ed` onwards).
