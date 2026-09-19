import { useEffect, useState } from "react";
import type { DuoApiConfig } from "./client.js";

const STORAGE_KEY = "duo.api-config";

/** Per-device convenience only (the daemon's own address and this device's paired token) — never state the daemon itself needs to read back, so localStorage is the right place for it (never a runtime capability's shared state). */
function readStoredConfig(): DuoApiConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DuoApiConfig) : null;
  } catch {
    return null;
  }
}

function writeStoredConfig(config: DuoApiConfig | null): void {
  try {
    if (config) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Private window, blocked storage, etc. — the setup screen just asks again next launch.
  }
}

/** Where this device's daemon connection (baseUrl + `duo pair` token) is remembered between launches. Returns `null` until pairing has been completed once on this device. */
export function useApiConfig(): [DuoApiConfig | null, (config: DuoApiConfig | null) => void] {
  const [config, setConfigState] = useState<DuoApiConfig | null>(() => readStoredConfig());

  useEffect(() => {
    writeStoredConfig(config);
  }, [config]);

  return [config, setConfigState];
}
