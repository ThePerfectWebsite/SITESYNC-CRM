"use client";

import { ChevronDown, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Global search (spec §9). Ctrl/Cmd-K focuses it; Enter opens the results page. */
export function GlobalSearch() {
  const input = useRef<HTMLInputElement>(null);
  const params = useSearchParams();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form role="search" action="/search" className="relative w-full max-w-sm">
      <label htmlFor="global-search" className="sr-only">
        Search clients, websites and projects
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        ref={input}
        id="global-search"
        name="q"
        type="search"
        defaultValue={params.get("q") ?? ""}
        maxLength={100}
        placeholder="Search clients, websites, projects"
        aria-keyshortcuts="Control+K Meta+K"
        className="h-9 w-full rounded-md border border-input bg-card pr-14 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1.5 text-[0.7rem] text-muted-foreground">
        Ctrl K
      </kbd>
    </form>
  );
}

/** Quick-create menu. Tasks and changes arrive with work tracking. */
export function QuickCreate() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="ml-auto h-9">
          <Plus aria-hidden="true" />
          New
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Create</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/clients/new">Client</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/websites/new">Website</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/projects/new">Project</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Task (coming soon)</DropdownMenuItem>
        <DropdownMenuItem disabled>Change (coming soon)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
