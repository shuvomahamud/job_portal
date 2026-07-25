import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/sidebar";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await auth.protect();

  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="px-4 py-7 sm:px-6 sm:py-9 lg:ml-[248px] lg:px-10 xl:px-14">
        <div className="mx-auto max-w-[1380px]">{children}</div>
      </main>
    </div>
  );
}
