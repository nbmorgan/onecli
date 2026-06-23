"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import * as driveApi from "@/lib/api/google-drive";
import type { GoogleDriveFolder } from "@/lib/api/types";
import type { PolicyDialogContentProps } from "../types";

/**
 * A selected folder. `ancestors` is the chain of real folder ids above it (from
 * the browse breadcrumb at selection time) so the UI can render an
 * "indeterminate" state on an unselected ancestor without re-walking the tree.
 * The gateway only reads `id`; allowing a folder allows its whole subtree.
 */
interface SelectedFolder {
  id: string;
  name: string;
  ancestors: string[];
}

const ROOT = { id: "root", name: "My Drive" };

const readSelected = (
  policy: Record<string, unknown> | null,
): SelectedFolder[] => {
  const folders = (policy?.folders as unknown[]) ?? [];
  return folders
    .map((f): SelectedFolder | null => {
      if (typeof f === "string") return { id: f, name: f, ancestors: [] };
      if (f && typeof f === "object") {
        const o = f as { id?: unknown; name?: unknown; ancestors?: unknown };
        if (typeof o.id === "string")
          return {
            id: o.id,
            name: typeof o.name === "string" ? o.name : o.id,
            ancestors: Array.isArray(o.ancestors)
              ? o.ancestors.filter((a): a is string => typeof a === "string")
              : [],
          };
      }
      return null;
    })
    .filter((f): f is SelectedFolder => f !== null);
};

type FolderState = "checked" | "covered" | "indeterminate" | "empty";

const STATE_TITLE: Record<FolderState, string> = {
  checked: "Allowed (this folder and everything inside it)",
  covered: "Allowed via a selected parent folder",
  indeterminate: "Contains an allowed subfolder — open to see",
  empty: "Not allowed",
};

const StateControl = ({
  state,
  onToggle,
}: {
  state: FolderState;
  onToggle: () => void;
}) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={state === "covered"}
    title={STATE_TITLE[state]}
    aria-label={STATE_TITLE[state]}
    className={cn(
      "flex size-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold transition-colors",
      state === "checked" &&
        "border-primary bg-primary text-primary-foreground",
      state === "covered" &&
        "border-primary/40 bg-primary/40 text-primary-foreground cursor-default",
      state === "indeterminate" &&
        "border-muted-foreground/40 text-muted-foreground bg-muted/40",
      state === "empty" && "border-muted-foreground/40",
    )}
  >
    {(state === "checked" || state === "covered") && (
      <Check className="size-3" />
    )}
    {state === "indeterminate" && "?"}
  </button>
);

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
  // Real folder ids on the path to the items currently shown.
  const pathIds = breadcrumb.filter((b) => b.id !== ROOT.id).map((b) => b.id);
  const coveredByAncestor =
    !searching && selected.some((s) => pathIds.includes(s.id));
  const allFolders = selected.length === 0;

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

  const stateOf = (f: GoogleDriveFolder): FolderState => {
    if (selected.some((s) => s.id === f.id)) return "checked";
    if (coveredByAncestor) return "covered";
    if (selected.some((s) => s.ancestors.includes(f.id)))
      return "indeterminate";
    return "empty";
  };

  const toggle = (f: GoogleDriveFolder) => {
    commit(
      selected.some((s) => s.id === f.id)
        ? selected.filter((s) => s.id !== f.id)
        : [...selected, { id: f.id, name: f.name, ancestors: pathIds }],
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

        {/* All folders (root) — clears any restriction. */}
        <button
          type="button"
          onClick={() => commit([])}
          className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
        >
          <StateControl
            state={allFolders ? "checked" : "empty"}
            onToggle={() => commit([])}
          />
          <HardDrive className="text-muted-foreground size-4 shrink-0" />
          <span className="flex-1 text-sm font-medium">All folders</span>
          <span className="text-muted-foreground text-xs">entire Drive</span>
        </button>

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
              {items.map((f) => (
                <li
                  key={f.id}
                  className="hover:bg-muted/40 flex items-center gap-2 px-2 py-1.5"
                >
                  <StateControl state={stateOf(f)} onToggle={() => toggle(f)} />
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
              ))}
            </ul>
          )}
        </ScrollArea>

        <p className="text-muted-foreground text-xs">
          {allFolders
            ? "All folders — agent has access to the entire Drive."
            : `${selected.length} folder${selected.length === 1 ? "" : "s"} (and their contents) selected.`}
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
