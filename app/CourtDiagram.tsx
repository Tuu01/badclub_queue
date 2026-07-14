// UI.md §5 — "the court card IS a court". Real court geometry in
// hairlines: doubles sidelines, service lines either side of the net,
// the net itself (dashed, centre). Team names sit in the two halves.
// Faint by design — "you feel them more than read them".

const W = 320;
const H = 132;
const ALLEY = 12;         // doubles sideline inset (top/bottom margin)
const SERVICE_INSET = 56; // service line distance from the net

const FONT = 17;

// Each name gets its half of the court, centred. Long names shrink to
// fit (SVG textLength) instead of overflowing the boundary — so a
// "Cuong Nguyen" compresses rather than spilling off the card.
function fit(name: string, avail: number): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  const est = name.length * FONT * 0.6; // rough width incl. the 110% stretch
  return est > avail ? { textLength: avail, lengthAdjust: 'spacingAndGlyphs' } : {};
}

function NameLines({ team, x, avail }: { team: [string, string] | null; x: number; avail: number }) {
  if (!team) return null;
  return (
    <>
      <text
        x={x} y={H / 2 - 6} textAnchor="middle" {...fit(team[0], avail)}
        className="fill-line-000 font-display"
        style={{ fontSize: FONT, fontWeight: 500, fontStretch: '110%' }}
      >
        {team[0]}
      </text>
      <text
        x={x} y={H / 2 + 18} textAnchor="middle" {...fit(team[1], avail)}
        className="fill-line-000 font-display"
        style={{ fontSize: FONT, fontWeight: 500, fontStretch: '110%' }}
      >
        {team[1]}
      </text>
    </>
  );
}

export function CourtDiagram({
  teamA,
  teamB,
}: {
  teamA: [string, string] | null;
  teamB: [string, string] | null;
}) {
  const netX = W / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Court">
      {/* outer boundary (doubles sidelines) */}
      <rect x={1} y={1} width={W - 2} height={H - 2} fill="none" className="stroke-line-800" strokeWidth={1} />
      {/* singles sidelines, inset */}
      <line x1={0} y1={ALLEY} x2={W} y2={ALLEY} className="stroke-line-800" strokeWidth={1} />
      <line x1={0} y1={H - ALLEY} x2={W} y2={H - ALLEY} className="stroke-line-800" strokeWidth={1} />
      {/* service lines, either side of the net */}
      <line x1={netX - SERVICE_INSET} y1={0} x2={netX - SERVICE_INSET} y2={H} className="stroke-line-800" strokeWidth={1} />
      <line x1={netX + SERVICE_INSET} y1={0} x2={netX + SERVICE_INSET} y2={H} className="stroke-line-800" strokeWidth={1} />
      {/* the net */}
      <line x1={netX} y1={0} x2={netX} y2={H} className="stroke-line-700" strokeWidth={1.5} strokeDasharray="3 4" />

      <NameLines team={teamA} x={W / 4} avail={W / 2 - 16} />
      <NameLines team={teamB} x={(W * 3) / 4} avail={W / 2 - 16} />
    </svg>
  );
}
