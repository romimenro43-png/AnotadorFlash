This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Backend: Supabase

Initiatives, tasks, saved meetings and task images are stored in Supabase.
Each browser signs in anonymously, and Row Level Security limits every user to their own data.

One-time setup:

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run the whole file `supabase/migrations/20260924000000_init.sql`.
   It creates the tables, the security policies, the `save_meeting` function and the private `task-images` storage bucket.
3. In **Authentication > Sign In / Providers**, turn on **Allow anonymous sign-ins**.
4. Copy `.env.example` to `.env.local` and fill in the project URL and publishable key from **Project Settings > API**.
5. Restart `npm run dev`.

Data model:

| Table | Purpose |
| --- | --- |
| `initiatives` | Name and color. Three defaults are created on the first visit. |
| `meetings` | Saved meetings with their title. |
| `tasks` | Notes. `meeting_id` is empty while the meeting is in progress. Saving a meeting moves them into it. |
| `task-images` bucket | One folder per user. Images are shown through temporary signed URLs. |

Anonymous sessions live in the browser. Clearing site data or switching browsers starts a new, empty account.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
