# AiroDrop Relay Server — Deployment Guide

This guide explains how to deploy the AiroDrop P2P Relay Server to your Oracle Cloud VPS and configure **Nginx Proxy Manager (NPM)** to route traffic.

---

## Part 1: Deploy on Oracle Cloud VPS

1. **Upload the `relay-server/` directory** from your local AiroDrop folder to your Oracle Cloud VPS at `~/airodrop/relay-server`.
   
   Your folder structure should look like this:
   ```bash
   ubuntu@instance:~/airodrop$ ls -F
   landing-page/  relay-server/
   ```

2. **Navigate to the directory**:
   ```bash
   cd ~/airodrop/relay-server
   ```

3. **Start the Docker container**:
   Since the `docker-compose.yml` points to the shared `nginx_default` network, run:
   ```bash
   docker compose up -d --build
   ```

4. **Verify it is running**:
   ```bash
   docker ps | grep airodrop-relay
   ```
   It should be online and listening internally on port `4000`.

---

## Part 2: Configure Nginx Proxy Manager (NPM)

You need to add paths to your existing proxy host so that HTTPS requests for WebSockets and downloads are forwarded to the new container.

### Step 1: Open NPM Admin Interface
Go to your Nginx Proxy Manager Admin panel (usually at port `81` on your VPS).

### Step 2: Edit your Existing Host
1. Go to **Hosts** &rarr; **Proxy Hosts**.
2. Find the row for `airodrop.bootstrapx007.online`.
3. Click the **Triple Dots (•••)** on the right and select **Edit**.

### Step 3: Configure Advanced Custom Locations
Click the **Custom Locations** tab inside the edit dialog. You need to add three location paths.

Click **Add Location** and enter the following settings:

#### Location 1: WebSocket Tunnel (`/ws`)
- **Define Location**: `/ws`
- **Scheme**: `http`
- **Forward Hostname / IP**: `airodrop-relay`
- **Forward Port**: `4000`
- Click the **Gear icon** to open Custom Nginx Configuration, and paste:
  ```nginx
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 86400;
  ```

#### Location 2: File Streaming Downloads (`/d/`)
- **Define Location**: `/d/`
- **Scheme**: `http`
- **Forward Hostname / IP**: `airodrop-relay`
- **Forward Port**: `4000`
- Click the **Gear icon** and paste:
  ```nginx
  proxy_buffering off;
  proxy_read_timeout 3600;
  ```

#### Location 3: Health check (`/health`)
- **Define Location**: `/health`
- **Scheme**: `http`
- **Forward Hostname / IP**: `airodrop-relay`
- **Forward Port**: `4000`

### Step 4: Enable WebSocket Support
Make sure the **Websockets Support** toggle is switched **ON** on the main **Details** tab of the Proxy Host edit dialog.

### Step 5: Save
Click **Save**. The proxy will restart in less than a second.

---

## Part 3: Test the Deployment

1. **Test HTTP Health Check**:
   Open a browser or run:
   ```bash
   curl https://airodrop.bootstrapx007.online/health
   ```
   It should return:
   ```json
   {"status":"ok","activeSessions":0,"activeShares":0,"uptime":...}
   ```

2. **Test Styled Expired Page**:
   Go to: `https://airodrop.bootstrapx007.online/d/nonexistent_token`
   It should serve a beautiful, dark-themed **Link Expired** page.
