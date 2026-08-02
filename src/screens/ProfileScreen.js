import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, Linking } from 'react-native';
import { fetchCalendarConnections, connectGoogleCalendar, signOut } from '../lib/api.js';
import { buildIcsFeed, buildGoogleCalendarUrl } from '../core/ics.js';
import { createTranslator } from '../core/i18n.js';
import { theme } from '../theme.js';

export default function ProfileScreen({ locale = 'en', user, isTeacher, onOpenImport, onSignedOut }) {
  const t = createTranslator(locale);
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    fetchCalendarConnections(user.id).then(setConnections).catch(() => {});
  }, [user.id]);

  const google = connections.find((c) => c.provider === 'google');
  const apple = connections.find((c) => c.provider === 'apple');

  async function handleConnectGoogle() {
    try {
      const { error } = await connectGoogleCalendar();
      if (error) throw error;
      setConnections(await fetchCalendarConnections(user.id));
    } catch (e) {
      Alert.alert('Calendar', e.message);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{user.name?.[0] ?? '?'}</Text></View>
        <View>
          <Text style={styles.name}>{user.name}</Text>
          <Text style={styles.role}>{t(isTeacher ? 'role.teacher' : 'role.student')}</Text>
        </View>
      </View>

      <Text style={styles.label}>{t('calendar.sync')}</Text>
      <View style={styles.card}>
        <SyncRow
          icon="📅"
          name={t('calendar.google')}
          connected={google?.sync_status === 'active'}
          t={t}
          onPress={handleConnectGoogle}
        />
        <SyncRow
          icon="🍎"
          name={t('calendar.apple')}
          connected={apple?.sync_status === 'active'}
          t={t}
          // Apple has no OAuth for calendars — we hand the user a subscribable
          // webcal feed instead, which needs no credentials at all (spec §7.3).
          onPress={() => Linking.openURL(`webcal://lessonwallet.app/feed/${user.id}.ics`)}
        />
      </View>
      <Text style={styles.note}>{t('calendar.note')}</Text>

      {isTeacher && google?.sync_status === 'active' && (
        <Pressable style={styles.importBtn} onPress={onOpenImport}>
          <Text style={styles.importText}>📥 {t('import.button')}</Text>
        </Pressable>
      )}

      <Pressable onPress={async () => { await signOut(); onSignedOut?.(); }}>
        <Text style={styles.logout}>{t('auth.logOut')}</Text>
      </Pressable>
    </View>
  );
}

function SyncRow({ icon, name, connected, onPress, t }) {
  return (
    <View style={styles.syncRow}>
      <Text style={styles.syncIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.syncName}>{name}</Text>
        <Text style={[styles.syncStatus, connected && styles.syncOn]}>
          {t(connected ? 'calendar.connected' : 'calendar.notConnected')}
        </Text>
      </View>
      <Pressable style={[styles.connectBtn, connected && styles.connectBtnOn]} onPress={onPress}>
        <Text style={[styles.connectText, connected && styles.connectTextOn]}>
          {t(connected ? 'calendar.disconnect' : 'calendar.connect')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.inkGreenDeep, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 },
  avatar: { width: 54, height: 54, borderRadius: 27, backgroundColor: theme.gold, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 21, color: theme.inkGreenDeep, fontWeight: '700' },
  name: { fontSize: 19, color: theme.ticket, fontWeight: '600' },
  role: { fontSize: 10.5, color: theme.goldSoft, textTransform: 'uppercase', marginTop: 2 },
  label: { color: theme.goldSoft, fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  card: { backgroundColor: theme.ticket, borderRadius: theme.radius.lg, paddingHorizontal: 16 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  syncIcon: { fontSize: 20, width: 26, textAlign: 'center' },
  syncName: { fontSize: 14, color: theme.textDark, fontWeight: '600' },
  syncStatus: { fontSize: 10.5, color: theme.textFade, marginTop: 2 },
  syncOn: { color: '#2E7D4F' },
  connectBtn: { borderWidth: 1.5, borderColor: theme.inkGreen, borderRadius: theme.radius.sm, paddingHorizontal: 12, paddingVertical: 7 },
  connectBtnOn: { backgroundColor: theme.inkGreen },
  connectText: { fontSize: 10.5, color: theme.inkGreen },
  connectTextOn: { color: theme.ticket },
  note: { fontSize: 11.5, color: 'rgba(239,231,211,0.4)', lineHeight: 18, paddingVertical: 10 },
  importBtn: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.ticketShadow, borderRadius: theme.radius.md, padding: 12, alignItems: 'center', marginBottom: 16 },
  importText: { fontSize: 11.5, color: theme.ticket },
  logout: { textAlign: 'center', color: theme.textFade, fontSize: 12, paddingTop: 10 },
});
