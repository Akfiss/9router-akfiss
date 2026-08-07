"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { CardSkeleton, SegmentedControl } from "@/shared/components";
import { resolveBansosTab } from "./page.logic.js";
import OverviewTab from "./components/OverviewTab";
import UsersKeysTab from "./components/UsersKeysTab";
import UsageLogsTab from "./components/UsageLogsTab";
import SettingsTab from "./components/SettingsTab";

const TAB_OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "users", label: "Users & Keys" },
  { value: "logs", label: "Usage & Logs" },
  { value: "settings", label: "Settings" },
];

export default function BansosPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <BansosContent />
    </Suspense>
  );
}

function BansosContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const activeTab = resolveBansosTab(searchParams.get("tab"));

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/bansos?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <SegmentedControl
        options={TAB_OPTIONS}
        value={activeTab}
        onChange={handleTabChange}
        className="w-full sm:w-auto"
      />

      {activeTab === "overview" && <OverviewTab />}
      {activeTab === "users" && <UsersKeysTab />}
      {activeTab === "logs" && <UsageLogsTab />}
      {activeTab === "settings" && <SettingsTab />}
    </div>
  );
}
