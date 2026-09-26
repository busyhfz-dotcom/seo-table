"use client";

import type { Locale } from "../../../lib/i18n";
import type { ConnectStrings } from "../connect/keys";
import { ConnectProvider } from "../connect/parts";
import { GoogleConnectForm } from "../connect/search-console";

/** The Google service-account form, outside the connect screen. */
export function GoogleConnectCard({
  kind,
  s,
  locale,
  projectId,
  baseUrl,
  canWrite,
  canRun,
}: {
  kind: "SEARCH_CONSOLE" | "GA4";
  s: ConnectStrings;
  locale: Locale;
  projectId: string;
  baseUrl: string;
  canWrite: boolean;
  canRun: boolean;
}) {
  return (
    <ConnectProvider value={{ s, locale, projectId, baseUrl, canWrite, canRun }}>
      <GoogleConnectForm kind={kind} />
    </ConnectProvider>
  );
}
