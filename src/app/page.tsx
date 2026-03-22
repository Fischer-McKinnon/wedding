import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white dark:bg-black font-sans">
      <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-white mb-8">
        Fischer-McKinnon Wedding
      </h1>
      <nav>
        <ul className="flex flex-col gap-4 text-lg text-center">
          <li><Link href="/guests" className="text-zinc-700 dark:text-zinc-300 hover:underline">Guests</Link></li>
          <li><Link href="/seating" className="text-zinc-700 dark:text-zinc-300 hover:underline">Seating</Link></li>
          <li><Link href="/food" className="text-zinc-700 dark:text-zinc-300 hover:underline">Food</Link></li>
        </ul>
      </nav>
    </main>
  );
}
