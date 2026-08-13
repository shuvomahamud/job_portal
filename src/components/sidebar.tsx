"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import {
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  FileCheck2,
  Layers3,
  MessageCircleQuestion,
  Settings,
  UserRound,
} from "lucide-react";
import { clsx } from "clsx";
import { Logo } from "./logo";

const navItems = [
  { href: "/", label: "Overview", icon: CircleGauge },
  { href: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/roles", label: "Roles", icon: Layers3 },
  { href: "/questions", label: "Questions", icon: MessageCircleQuestion },
  { href: "/applications", label: "Applications", icon: FileCheck2 },
  { href: "/profile", label: "Profile hub", icon: UserRound },
  { href: "/follow-ups", label: "Follow-ups", icon: CalendarClock },
  { href: "/settings", label: "Settings & API", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-[var(--line)] bg-[var(--paper)] px-5 py-6 lg:flex lg:flex-col">
        <div className="px-2">
          <Logo />
        </div>
        <nav className="mt-10 space-y-1" aria-label="Main navigation">
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx("nav-link", active && "nav-link-active")}
              >
                <item.icon className="size-[18px]" strokeWidth={1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-2xl border border-[var(--line)] bg-white/60 p-3">
          <div className="flex items-center gap-3">
            <UserButton
              appearance={{ elements: { avatarBox: "size-9" } }}
              showName
            />
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[rgba(247,246,241,.92)] px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center justify-between">
          <Logo compact />
          <UserButton appearance={{ elements: { avatarBox: "size-9" } }} />
        </div>
        <nav
          className="no-scrollbar mt-3 flex gap-1 overflow-x-auto"
          aria-label="Mobile navigation"
        >
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx("mobile-nav-link", active && "mobile-nav-active")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
