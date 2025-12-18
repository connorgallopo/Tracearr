# Tracearr Docker Examples

Ready-to-use Docker Compose files for deploying Tracearr via **Portainer**, **Proxmox**, or any Docker environment.

## Which should I use?

| Deployment     | Best For                           | Setup Complexity |
| -------------- | ---------------------------------- | ---------------- |
| **Supervised** | Most users, quick setup            | Zero config      |
| **Standard**   | Advanced users, existing databases | Requires secrets |

## Supervised (Recommended)

**File:** `docker-compose.supervised-example.yml`

All-in-one container with TimescaleDB, Redis, and Tracearr bundled together.

**Pros:**

- Zero configuration required
- Secrets auto-generated on first run
- Includes TimescaleDB Toolkit for advanced analytics
- Single container to manage

**Cons:**

- Less flexible for scaling
- Can't use existing database infrastructure

**Quick Start:**

```bash
docker compose -f docker-compose.supervised-example.yml up -d
```

## Standard (Separate Services)

**File:** `docker-compose.example.yml`

Traditional multi-container setup with separate database and cache services.

**Pros:**

- More control over individual services
- Can scale services independently
- Easier to integrate with existing infrastructure

**Cons:**

- Requires generating secrets manually
- More containers to manage
- Official TimescaleDB image doesn't include Toolkit extension

**Quick Start:**

```bash
# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# Deploy
docker compose -f docker-compose.example.yml up -d
```

## Portainer Deployment

1. Go to **Stacks** → **Add Stack**
2. Choose **Web editor** or **Upload**
3. Paste/upload the compose file content
4. For Standard deployment: Add environment variables under **Environment variables**
5. Click **Deploy the stack**

## Environment Variables

### Standard Deployment (Required)

| Variable        | Description                 | Example                |
| --------------- | --------------------------- | ---------------------- |
| `JWT_SECRET`    | Authentication token secret | `openssl rand -hex 32` |
| `COOKIE_SECRET` | Session cookie secret       | `openssl rand -hex 32` |

### All Deployments (Optional)

| Variable      | Default    | Description                              |
| ------------- | ---------- | ---------------------------------------- |
| `PORT`        | `3000`     | External port mapping                    |
| `TZ`          | `UTC`      | Timezone                                 |
| `LOG_LEVEL`   | `info`     | Log verbosity (debug, info, warn, error) |
| `DB_PASSWORD` | `tracearr` | Database password (standard only)        |
| `CORS_ORIGIN` | `*`        | Allowed CORS origins                     |

## Data Persistence

Both deployments use Docker volumes by default. To use bind mounts instead:

1. Create the data directories:

   ```bash
   mkdir -p ./data/postgres ./data/redis ./data/tracearr
   ```

2. Uncomment the bind mount lines in the compose file

3. Comment out the Docker volume lines

## Updating

```bash
docker compose pull
docker compose up -d
```

## Troubleshooting

**Container won't start:**

- Check logs: `docker compose logs tracearr`
- Ensure ports aren't in use: `netstat -tlnp | grep 3000`

**Database connection errors:**

- Wait for healthcheck to pass (up to 60s on first start)
- Check database logs: `docker compose logs timescale`
