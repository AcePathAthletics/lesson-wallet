import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert, RefreshControl } from 'react-native';
import { fetchTodayLessons, completeLesson } from '../lib/api.js';
import { wasLoggedLive, ATTENDANCE_SOURCE } from '../core/attendance.js';
import { createTranslator } from '../core/i18n.js';
import { theme } from '../theme.js';

export default function TeacherHomeScreen({ locale = 'en', teacherId, onOpenLog }) {
  const t = createTranslator(locale);
  const [lessons, setLessons] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setLessons(await fetchTodayLessons(teacherId));
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setRefreshing(false);
    }
  }, [teacherId]);

  useEffect(() => { load(); }, [load]);

  async function handleComplete(item) {
    setPending(item.id);
    // Optimistic update — the 5-second flow must feel instant (spec §10).
    setLessons((prev) =>
      prev.map((l) => (l.id === item.id ? { ...l, status: 'completed' } : l))
    );
    try {
      await completeLesson(item.id);
    } catch (e) {
      setLessons((prev) =>
        prev.map((l) => (l.id === item.id ? { ...l, status: item.status } : l))
      );
      Alert.alert(t('error.insufficientCredits'), e.message);
    } finally {
      setPending(null);
    }
  }

  const renderItem = ({ item }) => {
    const done = item.status === 'completed';
    const time = new Date(item.scheduled_at).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit',
    });
    return (
      <View style={[styles.ticket, done && styles.ticketDone]}>
        <View style={styles.ticketMain}>
          <View style={styles.timeRow}>
            <Text style={styles.time}>{time}</Text>
            {item.source === ATTENDANCE_SOURCE.CALENDAR_IMPORT && (
              <Text style={styles.badge}>{t('lesson.badgeImported')}</Text>
            )}
            {wasLoggedLive(item) && (
              <Text style={styles.badgeLogged}>{t('lesson.badgeLogged')}</Text>
            )}
          </View>
          <Text style={styles.name}>{item.student?.app_user?.name}</Text>
          <Text style={styles.course}>
            {item.course?.icon} {item.course?.name}
          </Text>
        </View>
        <Pressable
          style={[styles.stampBtn, done && styles.stampBtnDone]}
          disabled={done || pending === item.id}
          onPress={() => handleComplete(item)}
        >
          <Text style={[styles.stampText, done && styles.stampTextDone]}>
            {done ? '✓' : t('lesson.complete')}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.sectionLabel}>{t('home.today')}</Text>
      <FlatList
        data={lessons}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={<Text style={styles.empty}>{t('home.allDone')}</Text>}
        contentContainerStyle={{ paddingBottom: 90 }}
      />
      {/* Ad-hoc logging (spec §3.3) — reachable from anywhere. */}
      <Pressable style={styles.fab} onPress={onOpenLog} accessibilityLabel={t('log.title')}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.inkGreenDeep, padding: 16 },
  sectionLabel: { color: theme.goldSoft, fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  ticket: {
    backgroundColor: theme.ticket, borderRadius: theme.radius.lg,
    flexDirection: 'row', marginBottom: 12, overflow: 'hidden',
  },
  ticketDone: { opacity: 0.55 },
  ticketMain: { flex: 1, padding: 16 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  time: { color: theme.stampRed, fontSize: 11, letterSpacing: 1 },
  badge: { fontSize: 8, backgroundColor: 'rgba(31,58,46,0.12)', color: theme.inkGreen, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  badgeLogged: { fontSize: 8, backgroundColor: 'rgba(178,58,46,0.12)', color: theme.stampRed, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  name: { fontSize: 19, color: theme.textDark, marginTop: 2, fontWeight: '600' },
  course: { fontSize: 12.5, color: theme.textFade, marginTop: 3 },
  stampBtn: {
    width: 92, margin: 8, borderRadius: theme.radius.sm, borderWidth: 1.5,
    borderColor: theme.inkGreen, alignItems: 'center', justifyContent: 'center',
  },
  stampBtnDone: { borderColor: 'rgba(31,58,46,0.25)' },
  stampText: { color: theme.inkGreen, fontSize: 11, textAlign: 'center' },
  stampTextDone: { color: 'rgba(31,58,46,0.35)', fontSize: 18 },
  empty: { color: 'rgba(239,231,211,0.4)', fontSize: 13, paddingVertical: 20 },
  fab: {
    position: 'absolute', right: 18, bottom: 24, width: 56, height: 56,
    borderRadius: 28, backgroundColor: theme.stampRed,
    alignItems: 'center', justifyContent: 'center', elevation: 6,
  },
  fabText: { color: theme.ticket, fontSize: 30, lineHeight: 34 },
});
