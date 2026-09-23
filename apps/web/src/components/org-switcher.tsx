"use client";

/**
 * Switches the organization the session acts in. It is a plain HTML form
 * posting to /api/auth/org, which answers with a redirect back to `next`; the
 * script only submits it as soon as another organization is picked.
 */
export function OrgSwitcher({
  orgs,
  current,
  next,
  label,
}: {
  orgs: Array<{ id: string; name: string }>;
  current: string;
  next: string;
  label: string;
}) {
  return (
    <form action="/api/auth/org" method="post" className="orgsw">
      <input type="hidden" name="next" value={next} />
      <select
        name="orgId"
        defaultValue={current}
        aria-label={label}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id} translate="no">
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
