# Tracearr Docker Examples

Ready-to-use Docker Compose files for deploying Tracearr via **Portainer**, **Proxmox**, or any Docker environment. For project overview and features, see the [main README](../../README.md).

> **Unraid & TrueNAS Scale:** Use the Community Apps / TrueCharts instead of these compose files.

## Quick Reference

| File                                    | Description                       | RAM Required | Setup       |
| --------------------------------------- | --------------------------------- | ------------ | ----------- |
| `docker-compose.supervised-example.yml` | All-in-one (DB + Redis + App)     | **2GB min**  | Zero config |
| `docker-compose.example.yml`            | Separate services (standard)      | 1GB          | Secrets     |
| `docker-compose.pg18.yml`               | Separate services (PostgreSQL 18) | 1GB          | Secrets     |

---

## Supervised (Recommended for Most Users)

**File:** `docker-compose.supervised-example.yml`

Single container with TimescaleDB, Redis, and Tracearr bundled. Best for home servers and simple deployments.

| Pros                                       | Cons                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| Zero configuration — just deploy and go    | Requires minimum **2GB RAM** (PostgreSQL + Redis + App) |
| Secrets auto-generated on first run        | Less flexible for scaling                               |
| Includes TimescaleDB Toolkit for analytics | Can't use existing database infrastructure              |
| Single container to manage                 |                                                         |

```bash
docker compose -f docker-compose.supervised-example.yml up -d
```

Open `http://your-server:3000` and connect your media server.

---

## Standard (Separate Services)

**File:** `docker-compose.example.yml`

Traditional multi-container setup. Use this if you want more control or already have database infrastructure.

| Pros                                      | Cons                                               |
| ----------------------------------------- | -------------------------------------------------- |
| Lower memory per container (~1GB for app) | Requires generating secrets manually               |
| More control over individual services     | More containers to manage                          |
| Can integrate with existing PostgreSQL    | TimescaleDB Toolkit not included in official image |

```bash
# 1. Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# 2. Deploy
docker compose -f docker-compose.example.yml up -d
```

---

## PostgreSQL 18 (Experimental)

**File:** `docker-compose.pg18.yml`

Uses PostgreSQL 18 with TimescaleDB HA image. Includes Toolkit extension.

**WARNING:** For **new installations only**. Do not use with existing data volumes — the data format is incompatible with PostgreSQL 15/16.

---

## System Requirements

### Memory

| Deployment | Minimum RAM | Recommended |
| ---------- | ----------- | ----------- |
| Supervised | **2GB**     | 4GB         |
| Standard   | 1GB         | 2GB         |

The supervised container runs PostgreSQL, Redis, and Node.js. With less than 2GB RAM, the container will be killed by the OOM killer (exit code 137) and crash-loop.

**Container Memory Limits:** If you set `mem_limit` in Docker Compose, the container will auto-detect this limit and tune PostgreSQL accordingly. If auto-detection fails (e.g., nested containers), set `PG_MAX_MEMORY` explicitly to match your `mem_limit`.

---

## Portainer Deployment

### Supervised (Easiest)

1. Go to **Stacks** → **Add Stack**
2. Name it `tracearr`
3. Choose **Web editor**
4. Paste the contents of `docker-compose.supervised-example.yml`
5. Click **Deploy the stack**

That's it! No environment variables needed.

### Standard

1. Go to **Stacks** → **Add Stack**
2. Name it `tracearr`
3. Choose **Web editor**
4. Paste the contents of `docker-compose.example.yml`
5. Add environment variables:
   - `JWT_SECRET` = (generate with `openssl rand -hex 32`)
   - `COOKIE_SECRET` = (generate with `openssl rand -hex 32`)
6. Click **Deploy the stack**

---

## Environment Variables

### Required for Standard/PG18 Only

| Variable        | Description                 | How to Generate        |
| --------------- | --------------------------- | ---------------------- |
| `JWT_SECRET`    | Authentication token secret | `openssl rand -hex 32` |
| `COOKIE_SECRET` | Session cookie secret       | `openssl rand -hex 32` |

### Optional (All Deployments)

| Variable      | Default    | Description                              |
| ------------- | ---------- | ---------------------------------------- |
| `PORT`        | `3000`     | External port mapping                    |
| `TZ`          | `UTC`      | Timezone (e.g., `America/New_York`)      |
| `LOG_LEVEL`   | `info`     | Log verbosity (debug, info, warn, error) |
| `DB_PASSWORD` | `tracearr` | Database password (standard only)        |
| `CORS_ORIGIN` | `*`        | Allowed CORS origins                     |

### Supervised-Only

| Variable        | Default     | Description                                                                               |
| --------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `PG_MAX_MEMORY` | Auto-detect | PostgreSQL memory limit (e.g., `2GB`). Set if using `mem_limit` and auto-detection fails. |

For all configuration options, see the [main README](../../README.md#configuration).

---

## Data Persistence

Both deployments use Docker volumes by default (recommended). To use bind mounts instead, see the comments in the compose files.

---

## Updating

```bash
docker compose pull
docker compose up -d
```
