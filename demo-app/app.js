const clockFormat = new Intl.DateTimeFormat('tr-TR', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function formatClock(date) {
  return clockFormat.format(date);
}

if (typeof document !== 'undefined') {
  const clock = document.querySelector('#clock');
  const zone = document.querySelector('#dilim');
  zone.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function updateClock() {
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = formatClock(now);
  }
  updateClock();
  // Deliberate lifecycle finding for the static audit.
  setInterval(updateClock, 1000);
}
