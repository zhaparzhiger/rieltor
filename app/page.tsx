import Dashboard from "@/components/Dashboard";
import { hasGemini } from "@/lib/env";
import { readState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const state = await readState();
  return (
    <Dashboard
      initialListings={state.listings}
      initialStats={state.status === "done" ? state.stats : null}
      initialParams={state.params}
      finishedAt={state.finishedAt}
      aiConfigured={hasGemini()}
    />
  );
}
