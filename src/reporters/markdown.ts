import type { Report } from '../types.js';

const sections = {errors:'Kod sağlığı',security:'Güvenlik',performance:'Stabilite ve hız',ui:'Tasarım ve UI/UX',bugs:'Mantık ve sınır durumları',specialized:'Uzmanlık kuralları'};
const labels = {critical:'KRİTİK',high:'YÜKSEK',medium:'ORTA',low:'DÜŞÜK'};
function escape(value: unknown) {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_[\]#|!])/g,'\\$1');
}
export function markdown(report: Report): string {
  const {target,summary} = report;
  const lines = ['# D54 Report · '+escape(target.project),'','## Yönetici özeti','',
    'Hedef · '+[target.repo ?? target.root,target.url].filter(Boolean).map(escape).join(' · '),
    '', 'Teknoloji · '+(report.stack.map(escape).join(', ') || 'Belirlenemedi'),
    '', `Taranan dosya · ${report.filesScanned} · Toplam bulgu · ${summary.total} · Sağlık puanı · **${summary.health}/100**`,
    '', '| Kritik | Yüksek | Orta | Düşük |','| ---: | ---: | ---: | ---: |',
    '| '+Object.keys(labels).map(s=>summary.counts[s as keyof typeof labels]).join(' | ')+' |',
    '', '## Tarama kapsamı','',...report.coverage.map(n=>'- '+escape(n))];
  for (const [category,name] of Object.entries(sections)) {
    const findings = report.findings.filter(f=>f.category===category);
    if (!findings.length) continue;
    lines.push('','## '+name,'');
    for (const f of findings) {
      const location = f.file ? f.file+(f.line ? ':'+f.line : '') : [f.url,f.selector,f.viewport].filter(Boolean).join(' · ');
      lines.push(`- **[${f.id} | ${labels[f.severity]}] ${escape(f.title)}**`, '  - Konum · '+escape(location),
        '  - Sorun · '+escape(f.evidence),'  - Etki · '+escape(f.impact),'  - Çözüm · '+escape(f.advice));
      if (f.screenshot && /^screenshots\/[\w./-]+\.png$/.test(f.screenshot) && !f.screenshot.includes('..')) lines.push('  - [Ekran görüntüsü]('+f.screenshot+')');
    }
  }
  lines.push('','## Öncelikli aksiyon planı','');
  for (const [i,id] of report.priority.entries()) {
    const f = report.findings.find(item=>item.id===id)!;
    lines.push(`${i+1}. **${id}** · ${escape(f.advice)}`);
  }
  if (!report.priority.length) lines.push('Tamamlanan kontrollerde bulgu çıkmadı.');
  return lines.join('\n')+'\n';
}
