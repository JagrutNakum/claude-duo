const { Notification } = require('electron');

class NotificationManager {
  constructor(prefs = {}) {
    this.lastThresholdAlertPct = 0;
    this.lastResetAlertTs = 0;
    this.setPrefs(prefs);
  }

  // prefs mirror app_settings: notify_quota_alert, quota_alert_pct, notify_limit_reset,
  // notify_ping, notify_focus, notify_sound.
  setPrefs(prefs) {
    this.prefs = {
      notify_quota_alert: true,
      quota_alert_pct: 85,
      notify_limit_reset: true,
      notify_ping: true,
      notify_focus: true,
      notify_sound: true,
      ...prefs
    };
  }

  isSupported() {
    return Notification.isSupported();
  }

  // kind: 'quota' | 'reset' | 'ping' | 'focus' | 'system' (system toasts are always shown).
  showToast(title, body, isUrgent = false, kind = 'system') {
    if (!this.isSupported()) return;
    const gate = { quota: 'notify_quota_alert', reset: 'notify_limit_reset', ping: 'notify_ping', focus: 'notify_focus' }[kind];
    if (gate && !this.prefs[gate]) return;
    try {
      const toast = new Notification({
        title,
        body,
        silent: !this.prefs.notify_sound,
        urgency: isUrgent ? 'critical' : 'normal',
        timeoutType: isUrgent ? 'never' : 'default'
      });
      toast.show();
    } catch (err) {
      // Graceful fallback
    }
  }

  checkQuotaThreshold(usedPct, resetsAt) {
    const limit = this.prefs.quota_alert_pct;
    if (usedPct >= limit && this.lastThresholdAlertPct < limit) {
      this.lastThresholdAlertPct = limit;
      const resetStr = resetsAt ? ` Resets at ${new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
      this.showToast(`Claude Pro at ${usedPct}%`, `Shared 5-hour usage passed ${limit}%.${resetStr} Consider pausing heavy tasks.`, true, 'quota');
    } else if (usedPct < limit - 10) {
      this.lastThresholdAlertPct = 0;
    }
  }

  notifyReset() {
    const now = Date.now();
    if (now - this.lastResetAlertTs > 60000) {
      this.lastResetAlertTs = now;
      this.showToast('Claude limit reset', '5-hour limit reset. Full capacity available.', false, 'reset');
    }
  }

  notifyPriorityReserved(holderName, durationMinutes = 20) {
    this.showToast('Focus requested', `${holderName} requested focus for ${durationMinutes} minutes.`, false, 'focus');
  }

  notifyPriorityReleased(holderName) {
    this.showToast('Focus finished', `${holderName} finished focus time. Capacity is open.`, false, 'focus');
  }
}

module.exports = {
  NotificationManager
};
