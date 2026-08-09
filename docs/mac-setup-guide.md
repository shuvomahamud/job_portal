# Job Portal - Mac Setup & Deployment Guide

## Part 1: Local Development on Mac

### Prerequisites
- Node.js 20.9.0+ (check with `node --version`)
- Git (check with `git --version`)
- A Neon PostgreSQL database (already configured in Vercel)
- Clerk authentication (already configured)

### Installation

1. **Clone the repository:**
   ```bash
   git clone git@github.com:shuvomahamud/job_portal.git
   cd job_portal
   ```

2. **Install dependencies:**
   ```bash
   bun install
   # (project ships package-lock.json/npm scripts; npm install also works)
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` and fill in:
   - `DATABASE_URL` - Your Neon PostgreSQL connection string
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` - From Clerk Dashboard
   - `CLERK_SECRET_KEY` - From Clerk Dashboard
   - `APP_BASE_URL` - `http://localhost:3000` for local dev
   - `HERMES_COMMAND_SECRET` - Random secure string
   - `WORKER_API_SECRET` - Random secure string
   - Other optional fields (Telegram, N8N webhooks)

4. **Run database migrations:**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

5. **Seed the database (optional):**
   ```bash
   npm run db:seed
   ```

6. **Start the development server:**
   ```bash
   npm run dev
   ```
   
   Open [http://localhost:3000](http://localhost:3000) in your browser.

### Available Scripts

```bash
npm run dev              # Start Next.js dev server with hot reload
npm run build            # Build for production
npm run start            # Start production server
npm run lint             # Run ESLint
npm run typecheck        # Run TypeScript type checking
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Run database migrations
npm run db:studio        # Open Drizzle Studio UI
npm run db:seed          # Seed database with sample data
npm run db:verify        # Verify database setup
npm run test:smoke       # Run smoke tests
```

## Part 2: Vercel Deployment (Already Configured)

### Current Setup
Your project is already configured with Vercel:
- **Project ID:** `prj_SefQHuIn10kbKRbznxFYUy68S1Lq`
- **Project Name:** `job-portal`
- **Repository:** `shuvomahamud/job_portal`

### How Deployment Works
1. You push code to GitHub's `main` branch
2. Vercel automatically detects the push
3. Vercel builds and deploys your app
4. Live at: https://job-portal.vercel.app (or your custom domain)

### Setting Up Environment Variables on Vercel

1. **Go to Vercel Dashboard:**
   - Visit [https://vercel.com/dashboard](https://vercel.com/dashboard)
   - Click on the `job-portal` project

2. **Configure Environment Variables:**
   - Go to **Settings** → **Environment Variables**
   - Add all variables from your `.env.local`:
     ```
     DATABASE_URL=your_neon_connection_string
     NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_key
     CLERK_SECRET_KEY=your_clerk_secret
     APP_BASE_URL=https://job-portal.vercel.app
     HERMES_COMMAND_SECRET=your_secret
     WORKER_API_SECRET=your_secret
     N8N_WEBHOOK_SECRET=your_secret
     TELEGRAM_BOT_TOKEN=your_token
     TELEGRAM_ALLOWED_CHAT_ID=your_chat_id
     TELEGRAM_WEBHOOK_SECRET=your_secret
     SEED_USER_EMAIL=your_email@example.com
     SEED_USER_NAME=Your Name
     SEED_USER_AUTH_PROVIDER_ID=your_provider_id
     ```

3. **Deploy:**
   - Click **Deploy** button, or
   - Push new changes to `main` branch to auto-deploy

### Monitoring Deployment

```bash
# View Vercel logs locally
vercel logs job-portal --tail

# Deploy manually if needed
vercel deploy --prod
```

## Part 3: Worker Processes (Optional)

If you need the background worker service:

### Start Worker Locally
```bash
npm run worker:dev
```

### macOS Cron Job for Apply Cycle

To run apply cycles on a schedule, use launchd:

1. **Create LaunchAgent:**
   ```bash
   cp worker/launchd/com.jobportal.apply-cycle.plist.template \
      ~/Library/LaunchAgents/com.jobportal.apply-cycle.plist
   ```

2. **Edit the plist:**
   - Update paths to match your setup
   - Set desired schedule in `StartCalendarInterval`

3. **Load the agent:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.jobportal.apply-cycle.plist
   ```

4. **Check status:**
   ```bash
   launchctl list | grep jobportal
   launchctl log stream --predicate 'process == "launchd"' --level debug
   ```

## Part 4: Database Access

### View Database
```bash
# Open Drizzle Studio (interactive UI)
npm run db:studio
```

### Query Database Directly
```bash
# Use psql with Neon connection string
psql "$DATABASE_URL"
```

## Troubleshooting

### Build Fails on Vercel
- Check **Vercel Logs**: https://vercel.com/dashboard/job-portal
- Ensure all env vars are set in Vercel Settings
- Check database is accessible

### Can't Connect to Database Locally
- Verify `DATABASE_URL` in `.env.local`
- Ensure your IP is allowed in Neon's IP whitelist
- Test connection: `psql "$DATABASE_URL" -c "SELECT 1"`

### Port 3000 Already in Use
```bash
# Kill process on port 3000
lsof -i :3000
kill -9 <PID>

# Or use different port
PORT=3001 npm run dev
```

### TypeScript Errors
```bash
npm run typecheck
npm run lint --fix
```

## Quick Reference URLs

- **Local Dev:** http://localhost:3000
- **Production:** https://job-portal.vercel.app
- **Vercel Dashboard:** https://vercel.com/dashboard/job-portal
- **Clerk Dashboard:** https://dashboard.clerk.com
- **Neon Console:** https://console.neon.tech
- **Drizzle Studio:** Run `npm run db:studio`

## Next Steps

1. ✅ Merge complete - main branch updated
2. ✅ Pushed to GitHub - Vercel auto-deploying
3. Set environment variables in Vercel dashboard
4. Test deployment at production URL
5. Set up custom domain (if desired) in Vercel Settings
