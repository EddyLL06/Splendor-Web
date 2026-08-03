# Gem Council Server Setup (Debian 11)

This guide walks through installing Gem Council on one Debian 11 server with:

- one public HTTPS domain, such as `game.example.com`;
- Nginx serving the browser application;
- one private Node.js process managed by systemd;
- SQLite and avatars stored outside the Git checkout; and
- Resend delivering registration and password-reset email.

It is written as a copy-and-follow deployment guide. Replace every example
domain, email address, and credential with your own values before running the
commands.

> Debian 11 LTS ends on August 31, 2026. These steps are suitable for an
> existing Debian 11 server, but a new long-lived server should use a newer
> supported Debian release. The Gem Council-specific steps remain the same.

## 1. What you need before starting

Prepare the following:

- A Debian 11 server with a public IPv4 address, and optionally IPv6.
- A normal SSH user that can run `sudo`.
- A domain or subdomain for the game. This guide uses `game.example.com`.
- Access to the domain's DNS records.
- A Resend API key.
- A sender address under a domain already verified in Resend. This repository's
  default is `Gem Council <no-reply@auth.example.com>`.
- A backup destination outside `/srv/gem-council`, preferably on another
  server, storage bucket, or mounted backup volume.

The guide assumes the client and server use the same public origin:
`https://game.example.com`. This avoids unnecessary cross-origin and cookie
configuration.

Open only these inbound ports in the cloud firewall or security group:

| Port | Purpose |
| --- | --- |
| `22/tcp` | SSH administration; restrict to your IP when possible |
| `80/tcp` | Initial HTTP access and Let's Encrypt validation |
| `443/tcp` | The public HTTPS game |

Do **not** expose port `8000` publicly. Nginx is the only public entry point.

## 2. Point the domain at the server

Create an `A` record at your DNS provider:

```text
game.example.com  ->  YOUR_SERVER_IPV4
```

If the server has working IPv6, also create an `AAAA` record. Do not add an
AAAA record unless IPv6 traffic can actually reach the server.

Check the record from your computer:

```bash
dig +short game.example.com A
dig +short game.example.com AAAA
```

Continue once the returned address matches the server. Certificate issuance
will fail if the domain points somewhere else or port 80 is blocked.

## 3. Connect and update Debian

Connect over SSH:

```bash
ssh YOUR_ADMIN_USER@YOUR_SERVER_IP
```

Confirm the operating system and architecture:

```bash
cat /etc/os-release
dpkg --print-architecture
```

Update installed packages, then reboot if Debian installed a new kernel:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Reconnect after the reboot. Install the tools needed to download, build, and
serve the application:

```bash
sudo apt update
sudo apt install -y \
  ca-certificates \
  curl \
  git \
  nginx \
  build-essential \
  python3 \
  pkg-config
```

Enable Nginx now so it also starts after future reboots:

```bash
sudo systemctl enable --now nginx
sudo systemctl status nginx --no-pager
```

If the provider firewall is not the server's only firewall, configure Debian's
host firewall too. Keep the current SSH session open until a second SSH
connection succeeds. Replace `22` first if SSH uses a custom port:

```bash
sudo apt install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do not add an allow rule for port 8000.

## 4. Install Node.js 24

Debian 11's default Node.js package is too old for Gem Council. Install the
Node.js 24 package repository, then install Node.js:

```bash
cd /tmp
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
```

Verify the result:

```bash
node --version
npm --version
command -v node
command -v npm
```

`node --version` must start with `v24.`. Stop here and fix the Node installation
if a different major version appears.

## 5. Create a dedicated service account and directories

Run the game as its own non-login Linux user:

```bash
sudo useradd \
  --system \
  --user-group \
  --home-dir /srv/gem-council \
  --shell /usr/sbin/nologin \
  gemcouncil
```

If Debian reports that the user already exists, inspect it instead of creating
a duplicate:

```bash
getent passwd gemcouncil
```

Create the application and persistent-data directories:

```bash
sudo install -d -m 0755 -o gemcouncil -g gemcouncil /srv/gem-council
sudo install -d -m 0755 -o gemcouncil -g gemcouncil /srv/gem-council/app
sudo install -d -m 0700 -o gemcouncil -g gemcouncil /srv/gem-council/data
sudo install -d -m 0700 -o gemcouncil -g gemcouncil /srv/gem-council/data/database
sudo install -d -m 0700 -o gemcouncil -g gemcouncil /srv/gem-council/data/avatars
sudo install -d -m 0700 -o gemcouncil -g gemcouncil /srv/gem-council/data/tmp
```

The Git checkout will live in `/srv/gem-council/app`. Persistent data will live
in `/srv/gem-council/data`, so updating or replacing the checkout does not
delete accounts or avatars.

## 6. Download the application

Clone the `main` branch as the service account:

```bash
sudo -u gemcouncil -H git clone \
  --branch main \
  --single-branch \
  https://github.com/EddyLL06/Splendor-Web.git \
  /srv/gem-council/app
```

Confirm the checkout:

```bash
cd /srv/gem-council/app
sudo -u gemcouncil -H git status --short --branch
sudo -u gemcouncil -H git log -1 --oneline
```

Install the exact dependency versions from `package-lock.json`. Development
dependencies are required for Prisma generation, type checking, and building:

```bash
cd /srv/gem-council/app
sudo -u gemcouncil -H npm ci --include=dev
```

Do not use `npm install` for deployment; `npm ci` verifies and follows the
committed lockfile.

## 7. Create and edit the production environment

Generate the initial ignored `.env` file and strong local signing secrets:

```bash
cd /srv/gem-council/app
sudo -u gemcouncil -H npm run config:local
sudo chown gemcouncil:gemcouncil /srv/gem-council/app/.env
sudo chmod 0600 /srv/gem-council/app/.env
```

The command does not print the generated secrets. Edit the file with:

```bash
sudoedit /srv/gem-council/app/.env
```

Use the following block as an editing checklist rather than replacing the whole
file. Set these deployment values and keep the already generated values of
`SESSION_SECRET`, `VERIFICATION_CODE_PEPPER`, and `GAME_CREDENTIAL_SECRET`.
Do not modify those three secret lines.

```dotenv
NODE_ENV=production
APP_BASE_URL=https://game.example.com

# Leave blank because Nginx provides one same-origin public URL.
VITE_GAME_SERVER_URL=
GAME_SERVER_PORT=8000
GAME_ALLOWED_ORIGINS=https://game.example.com

APP_DATA_DIR=/srv/gem-council/data
DATABASE_URL=file:/srv/gem-council/data/database/app.sqlite
AVATAR_STORAGE_DIR=/srv/gem-council/data/avatars
UPLOAD_TEMP_DIR=/srv/gem-council/data/tmp

EMAIL_PROVIDER=resend
RESEND_API_KEY=PASTE_YOUR_RESEND_API_KEY_HERE
EMAIL_FROM=Gem Council <no-reply@auth.example.com>
EMAIL_REPLY_TO=

SESSION_DURATION_DAYS=30
VERIFICATION_CODE_TTL_MINUTES=10
VERIFICATION_CODE_RESEND_SECONDS=60
VERIFICATION_CODE_MAX_ATTEMPTS=5

# AI bots. 2-vCPU/2 GB servers should keep AI_BOT_WORKERS=1 and leave
# AI_BOT_EXPERT_ENABLED=false. AI_BOT_ENABLED=false is a no-migration
# pure-human rollback.
AI_BOT_ENABLED=true
AI_BOT_WORKERS=1
AI_BOT_QUEUE_LIMIT=256
AI_BOT_HARD_MAX_MS=80
AI_BOT_EXPERT_ENABLED=false
```

Important checks before saving:

- `APP_BASE_URL` and `GAME_ALLOWED_ORIGINS` must use the exact final HTTPS URL.
- Do not include a trailing slash in either origin.
- `VITE_GAME_SERVER_URL` should remain blank for this same-origin setup.
- `RESEND_API_KEY` must be the real server-side key, with no surrounding quotes.
- `EMAIL_FROM` must be accepted by your verified Resend domain.
- The three generated secrets must be independent, long random values.
- Never commit `.env`, print it into logs, or paste it into a support message.

Reapply ownership and permissions after editing:

```bash
sudo chown gemcouncil:gemcouncil /srv/gem-council/app/.env
sudo chmod 0600 /srv/gem-council/app/.env
```

## 8. Prepare storage, migrate, test, and build

Run the production preparation sequence as the service account:

```bash
cd /srv/gem-council/app
sudo -u gemcouncil -H npm run storage:prepare
sudo -u gemcouncil -H npm run prisma:generate
sudo -u gemcouncil -H npm run prisma:migrate:deploy
sudo -u gemcouncil -H npm run typecheck
sudo -u gemcouncil -H npm test
sudo -u gemcouncil -H npm run build
```

Every command must finish successfully. In particular:

- migration output should say all migrations were applied;
- tests should have no failures or skipped required suites;
- the build should create `dist/` and `dist-server/`; and
- a Vite chunk-size warning is informational and does not mean the build failed.

Check the output directories:

```bash
sudo -u gemcouncil -H test -f /srv/gem-council/app/dist/index.html
sudo -u gemcouncil -H test -f \
  /srv/gem-council/app/dist-server/src/server/server.js
```

## 9. Create the systemd service

Create `/etc/systemd/system/gem-council.service`:

```bash
sudoedit /etc/systemd/system/gem-council.service
```

Paste:

```ini
[Unit]
Description=Gem Council multiplayer server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=gemcouncil
Group=gemcouncil
WorkingDirectory=/srv/gem-council/app
ExecStart=/usr/bin/node /srv/gem-council/app/dist-server/src/server/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ReadWritePaths=/srv/gem-council/data

[Install]
WantedBy=multi-user.target
```

Validate and start it:

```bash
sudo systemd-analyze verify /etc/systemd/system/gem-council.service
sudo systemctl daemon-reload
sudo systemctl enable --now gem-council
sudo systemctl status gem-council --no-pager
```

Follow logs if it does not become active:

```bash
sudo journalctl -u gem-council -n 100 --no-pager
sudo journalctl -u gem-council -f
```

The application intentionally avoids logging passwords, session credentials,
verification codes, API keys, or email bodies.

Verify the backend locally:

```bash
curl -i http://127.0.0.1:8000/api/auth/me
curl -i http://127.0.0.1:8000/games
```

The first request should return `200` with a logged-out session. The second
should return `401` because the lobby requires authentication. Both responses
confirm that the process is reachable and the access boundary is active.

## 10. Configure Nginx

Create `/etc/nginx/sites-available/gem-council`:

```bash
sudoedit /etc/nginx/sites-available/gem-council
```

Paste the configuration below and replace `game.example.com` with the real
domain. If this domain already has an Nginx server block, add the `root` and
`location` entries to that block instead of creating a duplicate. Preserve any
unrelated existing locations.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name game.example.com;

    root /srv/gem-council/app/dist;
    index index.html;
    client_max_body_size 3m;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /games {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable the site, test the complete Nginx configuration, and reload:

```bash
sudo ln -s /etc/nginx/sites-available/gem-council \
  /etc/nginx/sites-enabled/gem-council
sudo nginx -t
sudo systemctl reload nginx
```

If the symlink already exists, do not create it again. Always run `nginx -t`
before reload; do not reload a configuration that fails validation.

Verify plain HTTP before requesting a certificate:

```bash
curl -I http://game.example.com/
curl -i http://game.example.com/api/auth/me
```

The root should return the built application, and `/api/auth/me` should reach
the Node process rather than return an Nginx 404 or 502.

## 11. Enable HTTPS with Certbot

Install Debian's Certbot package and Nginx plugin:

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

Request the certificate and let Certbot add HTTPS plus the HTTP-to-HTTPS
redirect:

```bash
sudo certbot --nginx \
  -d game.example.com \
  --redirect \
  --agree-tos \
  --no-eff-email \
  -m YOUR_ADMIN_EMAIL
```

Then validate Nginx and certificate renewal:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl list-timers --all | grep certbot
sudo certbot renew --dry-run
```

Port 80 must remain reachable for HTTP-based renewal unless you deliberately
change to a DNS-based certificate challenge.

## 12. Perform final public checks

Check the browser application and authenticated surfaces:

```bash
curl -I https://game.example.com/
curl -i https://game.example.com/api/auth/me
curl -i https://game.example.com/games
curl -i 'https://game.example.com/socket.io/?EIO=4&transport=polling'
```

Expected results:

- `/` returns `200` and the Gem Council HTML.
- `/api/auth/me` returns `200` with `user: null` before login.
- `/games` returns `401` before login.
- the Socket.IO polling request returns a handshake instead of an Nginx error.

Open `https://game.example.com` in two private/incognito browser windows and
complete this manual test:

1. Register two test accounts using email addresses you control.
2. Confirm the registration email arrives and the verification code works.
3. Create a public room with the first account.
4. Join from the second account and make one valid move.
5. Refresh both browsers and confirm each seat reconnects.
6. Create a private room and join it using its invitation link.
7. Upload and remove an avatar.
8. Request a password-reset email and complete the reset.
9. Switch between EN and 中文.
10. Log out and confirm the lobby and game can no longer be accessed.

Also inspect the service and proxy logs after the test:

```bash
sudo systemctl status gem-council nginx --no-pager
sudo journalctl -u gem-council -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

## 13. Back up persistent data

Accounts, sessions, challenges, and avatar metadata are in SQLite. Avatar files
are stored separately. Always back up the entire `/srv/gem-council/data`
directory as one unit.

The simplest consistent backup briefly stops the service. Stopping the service
also ends every active room because live matches are intentionally in memory.

```bash
sudo install -d -m 0700 /var/backups/gem-council
sudo systemctl stop gem-council
sudo tar \
  -C /srv/gem-council \
  -czf /var/backups/gem-council/gem-council-$(date +%F-%H%M%S).tar.gz \
  data
sudo systemctl start gem-council
sudo systemctl status gem-council --no-pager
```

Copy the archive off the server. A backup stored only on the same server is not
enough protection against disk or provider failure.

Test restoration on a separate server periodically. For an actual restore:

1. Stop `gem-council`.
2. Move the current data directory aside instead of deleting it.
3. Extract the selected archive beneath `/srv/gem-council`.
4. Run `sudo chown -R gemcouncil:gemcouncil /srv/gem-council/data`.
5. Confirm directory permissions are `0700`.
6. Start the service and test login plus avatar retrieval.

Keep the old data directory until the restored application has been verified.

## 14. Deploy future updates

Schedule a maintenance window because restarting the service removes active
rooms and games. Before each update, read the release notes and create a fresh
backup.

Use this sequence:

```bash
sudo systemctl stop gem-council
cd /srv/gem-council/app
sudo -u gemcouncil -H git fetch origin main
sudo -u gemcouncil -H git pull --ff-only origin main
sudo -u gemcouncil -H npm ci --include=dev
sudo -u gemcouncil -H npm run prisma:generate
sudo -u gemcouncil -H npm run prisma:migrate:deploy
sudo -u gemcouncil -H npm run typecheck
sudo -u gemcouncil -H npm test
sudo -u gemcouncil -H npm run ai:smoke
sudo -u gemcouncil -H npm run build
sudo systemctl start gem-council
sudo systemctl status gem-council --no-pager
sudo nginx -t
sudo systemctl reload nginx
```

Finish with the public checks from the previous section. If an update fails,
leave the service stopped, inspect the exact failed command, and restore both
the previous Git commit and the matching pre-update data backup. Do not run a
force reset or attempt to reverse a database migration blindly.

### Updating or rolling back the AI model

The AI model is one versioned JSON file, `ai_bot/models/heuristic-v1.json`,
whose manifest records the exact rules fingerprint it was trained against.
The server logs a warning at startup if that fingerprint no longer matches
the deployed rules, and falls back to built-in hand-tuned weights if the file
is missing or corrupt.

- **Upgrade:** replace the model file (or deploy a commit containing the new
  model), restart `gem-council`, and confirm the startup log says the rules
  fingerprint matches. There is no database migration for AI data.
- **Rollback:** either restore the previous model file, or set
  `AI_BOT_ENABLED=false` in `.env` and restart. Disabling AI requires no
  schema change and leaves account/room/human-play paths untouched.

## 15. Troubleshooting

### The service will not start

```bash
sudo systemctl status gem-council --no-pager
sudo journalctl -u gem-council -n 200 --no-pager
```

Common causes are an incomplete `.env`, a missing migration, unsafe storage
paths, wrong directory ownership, or a Node.js version other than 24.

Recheck:

```bash
node --version
sudo -u gemcouncil -H test -r /srv/gem-council/app/.env
sudo -u gemcouncil -H test -w /srv/gem-council/data
cd /srv/gem-council/app
sudo -u gemcouncil -H npm run storage:prepare
sudo -u gemcouncil -H npm run prisma:migrate:deploy
```

### Nginx returns 502 Bad Gateway

The Node process is unavailable or Nginx cannot reach it:

```bash
sudo systemctl status gem-council --no-pager
sudo ss -ltnp | grep ':8000'
curl -i http://127.0.0.1:8000/api/auth/me
sudo tail -n 100 /var/log/nginx/error.log
```

### Login or mutations return an origin error

Confirm the browser uses the exact URL configured in both variables:

```dotenv
APP_BASE_URL=https://game.example.com
GAME_ALLOWED_ORIGINS=https://game.example.com
```

Do not add a trailing slash. After changing `.env`, restart the service:

```bash
sudo systemctl restart gem-council
```

### The page loads but multiplayer does not update live

Recheck the `/socket.io/` location. It must pass the `Upgrade` and `Connection`
headers, use HTTP/1.1 on Debian 11's Nginx, and allow a long read timeout.

```bash
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
curl -i 'https://game.example.com/socket.io/?EIO=4&transport=polling'
```

### Registration email does not arrive

Check that:

- `EMAIL_PROVIDER=resend`;
- `RESEND_API_KEY` is valid;
- `EMAIL_FROM` belongs to a sender/domain verified in Resend;
- the server can make outbound HTTPS connections; and
- the message was not placed in spam.

Use Resend's delivery dashboard to inspect rejection, bounce, or suppression
status. Do not log or share verification codes while debugging.

### Avatar upload fails

The Nginx limit should be slightly above the application's 2 MB avatar limit:

```nginx
client_max_body_size 3m;
```

Also verify the private data paths are writable:

```bash
sudo -u gemcouncil -H test -w /srv/gem-council/data/avatars
sudo -u gemcouncil -H test -w /srv/gem-council/data/tmp
```

### Rooms disappeared after a restart

This is expected in this version. User accounts and avatars persist, but active
rooms and games exist only in the single Node process's memory. Keep exactly
one application instance and avoid load-balanced replicas, scale-to-zero, or
automatic process duplication.

## Official references

- [Debian 11 release and LTS lifecycle](https://www.debian.org/releases/bullseye/)
- [NodeSource Debian package instructions](https://github.com/nodesource/distributions/blob/master/DEV_README.md)
- [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [Certbot Nginx instructions](https://certbot.eff.org/instructions?ws=nginx&os=pip)
