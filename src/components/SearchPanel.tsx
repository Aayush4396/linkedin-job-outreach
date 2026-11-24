import { useEffect, useState } from "react";
import { Globe, Save } from "lucide-react";
import type { EmploymentChoice, SearchSettings, WorkplaceChoice } from "../lib/types";

interface SearchPanelProps {
  search: SearchSettings;
  extensionReady: boolean;
  browserBusy: boolean;
  onSaveSearch: (next: SearchSettings) => Promise<void>;
  onBrowserSearch: (next: SearchSettings) => Promise<void>;
}

export function SearchPanel({
  search,
  extensionReady,
  browserBusy,
  onSaveSearch,
  onBrowserSearch,
}: SearchPanelProps) {
  const [roles, setRoles] = useState(search.roles);
  const [locations, setLocations] = useState(search.locations);
  const [workplace, setWorkplace] = useState<WorkplaceChoice>(search.workplace);
  const [employment, setEmployment] = useState<EmploymentChoice>(search.employment);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRoles(search.roles);
    setLocations(search.locations);
    setWorkplace(search.workplace);
    setEmployment(search.employment);
  }, [search]);

  const currentValues: SearchSettings = {
    roles: roles.trim(),
    locations: locations.trim(),
    workplace,
    employment,
  };

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSearch(currentValues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-5">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">Saved search criteria</h2>
        <p className="mt-1 text-sm text-slate-600">
          LinkedIn searches for your roles or skills. HireMate checks locations, work arrangement,
          and employment type against each post before matching your résumé.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label htmlFor="roles" className="block text-xs font-semibold text-slate-700">
            Roles or skills (separate with commas)
          </label>
          <input
            id="roles"
            type="text"
            maxLength={240}
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
            placeholder="Software engineer, ML engineer, data analyst"
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          />
        </div>

        <div>
          <label htmlFor="locations" className="block text-xs font-semibold text-slate-700">
            Locations (separate with commas)
          </label>
          <input
            id="locations"
            type="text"
            maxLength={240}
            value={locations}
            onChange={(e) => setLocations(e.target.value)}
            placeholder="Any location"
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="workplace" className="block text-xs font-semibold text-slate-700">
              Work arrangement
            </label>
            <select
              id="workplace"
              value={workplace}
              onChange={(e) => setWorkplace(e.target.value as WorkplaceChoice)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              <option value="Any">Any</option>
              <option value="Remote">Remote</option>
              <option value="Hybrid">Hybrid</option>
              <option value="Onsite">Onsite</option>
            </select>
          </div>

          <div>
            <label htmlFor="employment" className="block text-xs font-semibold text-slate-700">
              Employment type
            </label>
            <select
              id="employment"
              value={employment}
              onChange={(e) => setEmployment(e.target.value as EmploymentChoice)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              <option value="Any">Any</option>
              <option value="Contract">Contract</option>
              <option value="Full-time">Full-time</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            id="saveSearch"
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Save className="w-4 h-4" aria-hidden="true" />
            <span>{saving ? "Saving…" : "Save search"}</span>
          </button>

          <button
            id="browserSearch"
            type="button"
            disabled={browserBusy || saving}
            onClick={() => onBrowserSearch(currentValues)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Globe className="w-4 h-4" aria-hidden="true" />
            <span>{browserBusy ? "Searching LinkedIn…" : "Find posts in my browser"}</span>
          </button>
        </div>

        {!extensionReady && (
          <p id="browserHint" className="text-xs text-slate-500 leading-relaxed">
            To use browser search, open this dashboard directly in the desktop Chrome profile where
            you installed the unpacked HireMate extension and signed in to LinkedIn.
          </p>
        )}
      </form>
    </section>
  );
}
