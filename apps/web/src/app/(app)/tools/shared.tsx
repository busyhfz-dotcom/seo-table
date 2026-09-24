"use client";

import { Icon } from "../../../components/icons";
import { Flash } from "../../../components/kit";
import { fmt } from "../../../lib/dict";
import type { CommonStrings } from "../../../lib/common-strings";
import type { ToolStrings } from "./strings";

export type ApplyTarget = { target: "WORDPRESS" | "CLOUDFLARE"; connected: boolean; supported: boolean; notes: string[] };
export type Proposal = { id: string; status: string; risk: string; needsApproval: boolean };

function targetName(t: ApplyTarget["target"], s: ToolStrings): string {
  return t === "CLOUDFLARE" ? s.target_cf : s.target_wp;
}

/** Whether the project's write route can put this file or block on the site. */
export function TargetNote({ target, s, c, connectHref }: { target: ApplyTarget; s: ToolStrings; c: CommonStrings; connectHref: string }) {
  const name = targetName(target.target, s);
  if (target.connected && target.supported) {
    return (
      <p className="small" style={{ color: "var(--ok)" }}>
        <Icon name="check" /> {fmt(s.target_ok, { target: name })}
      </p>
    );
  }
  return (
    <div className="note lock">
      <Icon name="alert" />
      <div>
        {target.connected ? fmt(s.target_unsupported, { target: name }) : fmt(s.target_missing, { target: name })} {c.manual_only}{" "}
        <a className="lnk" href={connectHref}>
          {c.connect_site}
        </a>
      </div>
    </div>
  );
}

/** The proposal a tool just created, and where it waits. */
export function ApplyResult({
  proposal,
  target,
  links,
  s,
  c,
}: {
  proposal: Proposal;
  target: ApplyTarget;
  links: { fixes: string; approvals: string };
  s: ToolStrings;
  c: CommonStrings;
}) {
  const href = proposal.status === "AWAITING_APPROVAL" ? links.approvals : links.fixes;
  return (
    <Flash tone="ok">
      <div>{c.proposal_created}</div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="small">{fmt(c.via_target, { target: targetName(target.target, s) })}</span>
        <a className="btn ghost sm" href={`${href}#${proposal.id}`}>
          <Icon name="shield" />
          {c.open_proposal}
        </a>
      </div>
    </Flash>
  );
}
