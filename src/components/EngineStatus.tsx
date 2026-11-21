import React, { useEffect, useState } from "react";

type EngineInfo = { label: string; state: "ready" | "resting" | "missing" };
type Job = {
  next: { label: string } | null;
  lastUsed: { label: string } | null;
  engines: EngineInfo[];
};
type Status = {
  key: boolean;
  text: Job;
  read: Job;
  speech: Job;
  transcribe: Job;
  call: Job;
};

// Other components fire this after they use an engine, so the line shows
// a failover as soon as it happens.
export const refreshEngineStatus = () =>
  window.dispatchEvent(new Event("router-refresh"));

const JOBS: {
  key: "text" | "read" | "speech" | "transcribe" | "call";
  name: string;
}[] = [
  { key: "text", name: "Text" },
  { key: "read", name: "Pages" },
  { key: "speech", name: "Voice" },
  { key: "transcribe", name: "Mic" },
  { key: "call", name: "Call" },
];

// One line showing which OpenAI model the router will use for each job.
export function EngineStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/router")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => alive && data && setStatus(data))
        .catch(() => {});

    load();
    const timer = setInterval(load, 20_000);
    window.addEventListener("router-refresh", load);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("router-refresh", load);
    };
  }, []);

  if (!status) return null;

  if (!status.key) {
    return (
      <div className="px-1 pt-3 uppercase text-primary">
        No OpenAI key: add OPENAI_API_KEY to .env and restart
      </div>
    );
  }

  return (
    <div className="px-1 pt-3 flex flex-wrap gap-x-5 gap-y-1 uppercase opacity-60">
      <span>Router</span>
      {JOBS.map(({ key, name }) => {
        const job = status[key];
        if (!job) return null;
        const resting = job.engines.filter((e) => e.state === "resting");
        return (
          <span
            key={key}
            title={job.engines.map((e) => `${e.label}: ${e.state}`).join("\n")}
          >
            {name} {job.next?.label ?? "none available"}
            {resting.length > 0 && ` (${resting.length} resting)`}
          </span>
        );
      })}
    </div>
  );
}
