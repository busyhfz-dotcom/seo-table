"use client";
import { useState } from "react";
import Link from "next/link";

const opportunities = [
 { title: "Give every page a distinct title", category: "Metadata", impact: "High", pages: 12, description: "Review duplicate titles and write a specific title for each page. Keep the intent of the existing content." },
 { title: "Connect your most valuable pages", category: "Internal links", impact: "High", pages: 8, description: "Add contextual internal links from relevant pages to help visitors discover related content." },
 { title: "Complete missing image descriptions", category: "Accessibility", impact: "Medium", pages: 21, description: "Describe meaningful images with useful alternative text. Decorative images can have empty alt text." },
 { title: "Review structured data coverage", category: "Technical", impact: "Medium", pages: 6, description: "Check that structured data accurately represents the visible content before adding or changing markup." }
];
export default function Workspace({ onboarding = false }: { onboarding?: boolean }) {
 const [view, setView] = useState(onboarding ? "Add website" : "Overview");
 const [query, setQuery] = useState("");
 const [filter, setFilter] = useState("All");
 const [selected, setSelected] = useState<number | null>(null);
 const [mode, setMode] = useState("Invisible");
 const [domain, setDomain] = useState("");
 const [notice, setNotice] = useState("");
 const [site, setSite] = useState("");
 const rows = opportunities.filter(o => (filter === "All" || o.impact === filter) && (o.title + o.category).toLowerCase().includes(query.toLowerCase()));
 function prepare(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
  try {
   const url = new URL(domain.includes("://") ? domain : "https://" + domain);
   if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error();
   setSite(url.hostname); setNotice("Website configured for this session. Live scanning is not connected yet."); setView("Overview");
  } catch { setNotice("Enter a valid website address, such as example.com."); }
 }
 return <div className="workspace">
  <a className="skip" href="#main">Skip to content</a>
  <aside className="sidebar">
   <Link className="brand" href="/"><span className="brandmark">S</span>seo<span className="brandlight">table</span><span className="beta">BETA</span></Link>
   <div className="workspace-label">YOUR WORKSPACE</div>
   <div className="workspace-name"><span className="avatar">P</span><div>Personal workspace<small>Product preview</small></div></div>
   <nav aria-label="Workspace">{["Overview","Opportunities","Recommendations","Reports","Add website"].map((n,i)=><button key={n} onClick={()=>{setView(n);setSelected(null);}} className={view===n?"nav-active":""} aria-current={view===n?"page":undefined}><span aria-hidden="true">{["◫","↗","✧","▤","+"][i]}</span>{n}</button>)}</nav>
   <div className="sidebar-bottom"><div className="tiny-label">BUILT FOR YOUR EXISTING SITE</div><p>More potential.<br/>Same website.</p><span className="muted">Improve what you already have.</span><Link href="/onboarding" className="sidebar-link">Set up a website →</Link></div>
   <div className="profile"><span className="avatar">Y</span><div>Your workspace<small>Preview access</small></div></div>
  </aside>
  <div className="main-wrap">
   <header className="topbar"><span>Workspace <span className="muted">/</span> {view}</span><span className="preview-chip">Demo environment</span></header>
   <main id="main">
    <div className="heading"><div><div className="eyebrow">SEO TABLE / GROWTH WORKSPACE</div><h1>{view === "Overview" ? "See the bigger picture." : view}</h1><p className="muted">{view==="Overview"?"Your website’s next opportunities, all in one place.":"Turn insights into thoughtful improvements."}</p></div><button className="primary" onClick={()=>{setView("Add website");setNotice("");}}>+ Add website</button></div>
    <div className="demo-note"><span>ⓘ</span> Sample data for exploring the interface. No website has been crawled or modified.</div>
    {notice && <div role="status" className="notice">{notice}</div>}
    {view==="Add website" ? <section className="setup panel"><div className="eyebrow">01 / SET UP YOUR WEBSITE</div><h2>A little context. A better starting point.</h2><p className="muted">Choose how you want to improve your website.</p><form onSubmit={prepare}><label htmlFor="domain">Website address</label><input id="domain" required value={domain} onChange={e=>setDomain(e.target.value)} placeholder="example.com" autoComplete="url" /><fieldset><legend>Optimization mode</legend><div className="mode-grid">{["Invisible","Full optimization"].map(m=><label className={"mode-card "+(mode===m?"chosen":"")} key={m}><input type="radio" name="mode" checked={mode===m} onChange={()=>setMode(m)}/><strong>{m}</strong><p>{m==="Invisible"?"Preserve your design. Focus on metadata, technical fixes and structured data.":"Review broader content and structure changes before they are applied."}</p></label>)}</div></fieldset><p className="muted">This preview keeps your selection only for the current session. Connecting a website and running a scan will be available after backend integration.</p><button className="primary" type="submit">Use this website in preview →</button></form></section> : <>
    <div className="site-strip"><span className="site-icon">◎</span><div><strong>{site || "example.com"}</strong><small>{site ? mode+" mode · Not connected" : "Sample website · Invisible mode"}</small></div><span className="tag">Preview</span><button className="text-button" onClick={()=>setView("Add website")}>Change website ↗</button></div>
    {view==="Overview" && <>
     <section className="stats" aria-label="Sample SEO metrics">{[["SEO health","78","out of 100","12 points to your next milestone"],["Organic clicks","12,840","sample / 28 days","Search Console not connected"],["Opportunities","47","sample findings","12 high-impact improvements"],["Pages reviewed","246","sample pages","Live crawling not connected"]].map(([label,value,unit,desc])=><article className="panel stat" key={label}><span className="muted">{label}</span><div className="stat-value">{value}<small>{unit}</small></div><div className="stat-footer">{desc}</div></article>)}</section>
     <section className="insight-grid"><article className="panel trend"><div className="section-heading"><div><h2>Organic performance</h2><p className="muted">Illustrative clicks · Last 28 days</p></div><span className="tag">Sample</span></div><div className="chart" role="img" aria-label="Illustrative organic clicks trend increasing across four weeks; sample data only"><div className="chart-axis"><span>15k</span><span>10k</span><span>5k</span></div><svg viewBox="0 0 700 180" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#bbf975" stopOpacity=".25"/><stop offset="100%" stopColor="#bbf975" stopOpacity="0"/></linearGradient></defs><path d="M0 145 L35 130 L70 138 L105 107 L140 118 L175 94 L210 108 L245 76 L280 85 L315 60 L350 75 L385 45 L420 65 L455 34 L490 50 L525 20 L560 35 L595 16 L630 26 L665 10 L700 18 L700 180 L0 180 Z" fill="url(#area)"/><path d="M0 145 L35 130 L70 138 L105 107 L140 118 L175 94 L210 108 L245 76 L280 85 L315 60 L350 75 L385 45 L420 65 L455 34 L490 50 L525 20 L560 35 L595 16 L630 26 L665 10 L700 18" fill="none" stroke="#bbf975" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg></div><div className="chart-labels"><span>Week 1</span><span>Week 2</span><span>Week 3</span><span>Week 4</span></div></article><article className="panel focus"><span className="eyebrow">YOUR NEXT MOVE</span><span className="focus-symbol" aria-hidden="true">✧</span><h2>Small changes.<br/>More possibilities.</h2><p>Start with high-impact improvements that preserve your website’s look and feel.</p><button onClick={()=>setView("Opportunities")} className="primary">Explore opportunities ↗</button></article></section>
    </>}
    {(view==="Overview" || view==="Opportunities" || view==="Recommendations") && <section className="panel opportunities"><div className="section-heading"><div><h2>{view==="Recommendations"?"Recommendation review":"Opportunities worth exploring"}</h2><p className="muted">Example findings, prioritized by potential impact.</p></div><span className="tag">{rows.length} examples</span></div><div className="table-tools"><div className="filters" aria-label="Impact filter">{["All","High","Medium"].map(n=><button aria-pressed={filter===n} className={filter===n?"selected":""} key={n} onClick={()=>setFilter(n)}>{n==="All"?"All opportunities":n+" impact"}</button>)}</div><input aria-label="Search opportunities" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search opportunities…" /></div><div className="table-scroll"><table><thead><tr><th>Opportunity</th><th>Impact</th><th>Pages</th><th><span className="sr-only">Review</span></th></tr></thead><tbody>{rows.map(o=><tr key={o.title}><td><strong>{o.title}</strong><small>{o.category}</small></td><td><span className={"impact "+o.impact.toLowerCase()}>{o.impact}</span></td><td>{o.pages}</td><td><button className="review" onClick={()=>setSelected(opportunities.indexOf(o))}>Review ↗</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">No matching opportunities. Try a different search or filter.</p>}</div>{selected!==null && <div className="detail" role="region" aria-label="Recommendation detail"><button className="text-button" onClick={()=>setSelected(null)}>Close ×</button><h3>{opportunities[selected].title}</h3><p>{opportunities[selected].description}</p><span className="muted">Sample recommendation. Applying changes requires a connected website and an approval workflow.</span></div>}</section>}
    {view==="Reports" && <section className="panel setup"><span className="eyebrow">REPORTS</span><h2>Your first report starts with a real scan.</h2><p className="muted">Connect your website and Search Console to build reports from verified data. The sample metrics in Overview are for preview only.</p><button className="primary" onClick={()=>setView("Add website")}>Set up website →</button></section>}
    </>}
    <footer>SEO Table <span>Thoughtful improvements. Measurable progress.</span><span>Interface preview · v0.1</span></footer>
   </main>
  </div>
 </div>;
}
