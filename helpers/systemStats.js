const os = require('os');

function ramStats() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    totalMb: Math.round(totalBytes / (1024 * 1024)),
    usedMb: Math.round(usedBytes / (1024 * 1024)),
    freeMb: Math.round(freeBytes / (1024 * 1024)),
    usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10
  };
}

function cpuSnapshot() {
  return os.cpus().map((core) => {
    const times = core.times;
    const idle = times.idle;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle, total };
  });
}

// Measures CPU usage % by comparing two snapshots `sampleMs` apart.
function cpuUsagePercent(sampleMs = 200) {
  return new Promise((resolve) => {
    const start = cpuSnapshot();
    setTimeout(() => {
      const end = cpuSnapshot();
      let idleDiff = 0;
      let totalDiff = 0;
      for (let i = 0; i < start.length; i += 1) {
        idleDiff += end[i].idle - start[i].idle;
        totalDiff += end[i].total - start[i].total;
      }
      const percent = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
      resolve(Math.round(percent * 10) / 10);
    }, sampleMs);
  });
}

function serverStatus() {
  return {
    uptimeSeconds: Math.round(process.uptime()),
    loadAverage: os.loadavg()[0] // 1-minute load average
  };
}

module.exports = { ramStats, cpuUsagePercent, serverStatus };
