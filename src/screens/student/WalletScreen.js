import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { fetchWallet } from '../../lib/api.js';
import { createTranslator } from '../../core/i18n.js';
import { isLowBalance } from '../../core/credits.js';
import { theme } from '../../theme.js';

/** The student's credit wallet — the screen the product is named after. */
export default function WalletScreen({ locale = 'en', studentId, studentName }) {
  const t = createTranslator(locale);
  const [wallet, setWallet] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try { setWallet(await fetchWallet(studentId)); } finally { setRefreshing(false); }
  }
  useEffect(() => { load(); }, [studentId]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.hello}>{t('student.hello', { name: studentName })}</Text>
      <Text style={styles.label}>{t('student.myLessons')}</Text>
      <FlatList
        data={wallet}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        renderItem={({ item }) => {
          const low = isLowBalance({
            purchasedLessons: item.purchased_lessons,
            usedLessons: item.used_lessons,
          });
          return (
            <View style={styles.card}>
              <Text style={styles.icon}>{item.course?.icon ?? '📘'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.course}>{item.course?.name}</Text>
                {low && <Text style={styles.low}>{t('notify.lowCreditSelf', { count: item.remaining_lessons })}</Text>}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.count}>{item.remaining_lessons}</Text>
                <Text style={styles.unit}>{t('lesson.left')}</Text>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.inkGreenDeep, padding: 16 },
  hello: { fontSize: 21, color: theme.ticket, marginBottom: 16, fontWeight: '600' },
  label: { color: theme.goldSoft, fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  card: { backgroundColor: theme.ticket, borderRadius: theme.radius.lg, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  icon: { fontSize: 26 },
  course: { fontSize: 16.5, color: theme.textDark, fontWeight: '600' },
  low: { fontSize: 11, color: theme.stampRed, marginTop: 2 },
  count: { fontSize: 22, color: theme.stampRed, fontWeight: '700' },
  unit: { fontSize: 9, color: theme.textFade, textTransform: 'uppercase' },
});
