"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import * as driveApi from "@/lib/api/google-drive";
import type { GoogleDriveFolder } from "@/lib/api/types";
import type { PolicyDialogContentProps } from "../types";

interface SelectedFolder {
  id: string;
  name: string;
}

const ROOT = { id: "root", name: "My Drive" };

const readSelected = (
  policy: Record<string, unknown> | null,
): SelectedFolder[] => {
  const folders = (policy?.folders as unknown[]) ?? [];
  return folders
    .map((f): SelectedFolder | null => {
      if (typeof f === "string") return { id: f, name: f };
      if (f && typeof f === "object") {
        const o = f as { id?: unknown; name?: unknown };
        if (typeof o.id === "string")
          return { id: o.id, name: typeof o.name === "string" ? o.name : o.id };
      }
      return null;
    })
    .filter((f): f is SelectedFolder => f !== null);
};

/**
 * Live Google Drive folder browser for granular-access scoping. Lets the user
 * drill into folders, search by name, and check the folders an agent may use.
 * Selection is stored on the policy as `{ folders: [{ id, name }] }`, which the
 * gateway reads to enforce folder scope (see google-drive-policy.ts).
 */
export const GoogleDriveFolderPicker = ({
  connectionId,
  policy,
  onPolicyChange,
  onSave,
  onCancel,
}: PolicyDialogContentProps) => {
  const [selected, setSelected] = useState<SelectedFolder[]>(() =>
    readSelected(policy),
  );
  const [items, setItems] = useState<GoogleDriveFolder[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([
    ROOT,
  ]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = breadcrumb[breadcrumb.length - 1]!;
  const searching = search.trim().length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = searching
        ? await driveApi.searchFolders(connectionId, search.trim())
        : await driveApi.folders(connectionId, current.id);
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load folders");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId, current.id, search, searching]);

  useEffect(() => {
    const t = setTimeout(load, searching ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, searching]);

  const commit = (next: SelectedFolder[]) => {
    setSelected(next);
    onPolicyChange(next.length > 0 ? { folders: next } : {});
  };

  const toggle = (f: GoogleDriveFolder) => {
    commit(
      selected.some((s) => s.id === f.id)
        ? selected.filter((s) => s.id !== f.id)
        : [...selected, { id: f.id, name: f.name }],
    );
  };

  const openFolder = (f: GoogleDriveFolder) => {
    setSearch("");
    setBreadcrumb((b) => [...b, { id: f.id, name: f.name }]);
  };

  const jumpTo = (index: number) => {
    setSearch("");
    setBreadcrumb((b) => b.slice(0, index + 1));
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-3 px-5 py-4">
        <Input
          placeholder="Search folders…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
        />

        {!searching && (
          <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
            {breadcrumb.map((b, i) => (
              <span key={b.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" />}
                <button
                  type="button"
                  onClick={() => jumpTo(i)}
                  className={cn(
                    "hover:text-foreground transition-colors",
                    i === breadcrumb.length - 1 &&
                      "text-foreground font-medium",
                  )}
                >
                  {b.name}
                </button>
              </span>
            ))}
          </div>
        )}

        <ScrollArea className="h-56 rounded-md border">
          {loading ? (
            <div className="text-muted-foreground flex h-56 items-center justify-center gap-2 text-xs">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="text-destructive flex h-56 items-center justify-center px-4 text-center text-xs">
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground flex h-56 items-center justify-center text-xs">
              {searching ? "No matching folders" : "No subfolders"}
            </div>
          ) : (
            <ul className="divide-border/40 divide-y">
              {items.map((f) => {
                const checked = selected.some((s) => s.id === f.id);
                return (
                  <li
                    key={f.id}
                    className="hover:bg-muted/40 flex items-center gap-2 px-2 py-1.5"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(f)}
                      aria-label={`Select ${f.name}`}
                    />
                    <Folder className="text-muted-foreground size-4 shrink-0" />
                    <span className="flex-1 truncate text-sm">{f.name}</span>
                    {!searching && (
                      <button
                        type="button"
                        onClick={() => openFolder(f)}
                        className="hover:bg-muted text-muted-foreground rounded p-1"
                        aria-label={`Open ${f.name}`}
                      >
                        <ChevronRight className="size-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <p className="text-muted-foreground text-xs">
          {selected.length === 0
            ? "No folders selected — agent has access to all of Drive."
            : `${selected.length} folder${selected.length === 1 ? "" : "s"} selected.`}
        </p>
      </div>

      <DialogFooter className="border-border/50 border-t px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave}>
          Save
        </Button>
      </DialogFooter>
    </div>
  );
};
