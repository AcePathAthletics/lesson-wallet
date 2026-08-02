import React, { useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, Alert } from 'react-native';
import { logLessonNow } from '../lib/api.js';
import { createTranslator } from '../core/i18n.js';
import { theme } from '../theme.js';

/**
 * Ad-hoc lesson logging (spec §3.3): pick student → pick course → confirm.
 * Three taps, no typing — the walk-in / makeup case.
 */
export default function LogLessonSheet({ visible, locale = 'en', roster, onClose, onLogged }) {
  const t = createTranslator(locale);
  const [step, setStep] = useState('student');
  const [student, setStudent] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep('student'); setStudent(null); setEnrollment(null);
  }

  function close() { reset(); onClose?.(); }

  async function confirm() {
    setBusy(true);
    try {
      const att = await logLessonNow({
        studentId: student.user_id,
        courseId: enrollment.course.id,
      });
      onLogged?.(att);
      close();
    } catch (e) {
      Alert.alert(t('error.insufficientCredits'), e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        {step === 'student' && (
          <>
            <Text style={styles.title}>{t('log.pickStudent')}</Text>
            <Text style={styles.sub}>{t('log.pickStudentSub')}</Text>
            <ScrollView style={styles.list}>
              {roster.map((s) => (
                <Pressable
                  key={s.user_id}
                  style={styles.row}
                  onPress={() => { setStudent(s); setStep('course'); }}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{s.app_user?.name?.[0]}</Text>
                  </View>
                  <View>
                    <Text style={styles.rowName}>{s.app_user?.name}</Text>
                    <Text style={styles.rowSub}>
                      {s.enrollment.map((e) => e.course.name).join(' · ')}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        {step === 'course' && (
          <>
            <Pressable onPress={() => setStep('student')}>
              <Text style={styles.back}>‹ {t('common.back')}</Text>
            </Pressable>
            <Text style={styles.title}>{t('log.pickCourse')}</Text>
            <Text style={styles.sub}>{t('log.pickCourseSub')}</Text>
            {student?.enrollment.map((e) => (
              <Pressable
                key={e.id}
                style={styles.chip}
                onPress={() => { setEnrollment(e); setStep('confirm'); }}
              >
                <Text style={styles.chipName}>{e.course.name}</Text>
                <Text style={styles.chipCount}>
                  {e.remaining_lessons} {t('lesson.left')}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {step === 'confirm' && (
          <>
            <Pressable onPress={() => setStep('course')}>
              <Text style={styles.back}>‹ {t('common.back')}</Text>
            </Pressable>
            <Text style={styles.title}>{t('log.confirm')}</Text>
            <View style={styles.summary}>
              <Text style={styles.summaryName}>{student?.app_user?.name}</Text>
              <Text style={styles.summaryCourse}>
                {enrollment?.course.name} · {enrollment?.remaining_lessons} →{' '}
                {Math.max(0, (enrollment?.remaining_lessons ?? 0) - 1)} {t('lesson.left')}
              </Text>
            </View>
            <Pressable style={styles.cta} onPress={confirm} disabled={busy}>
              <Text style={styles.ctaText}>{t('log.confirmBtn')}</Text>
            </Pressable>
          </>
        )}

        <Pressable onPress={close}>
          <Text style={styles.close}>{t('common.close')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: theme.ticket, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22 },
  handle: { width: 36, height: 4, backgroundColor: theme.ticketShadow, borderRadius: 3, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '600', color: theme.textDark },
  sub: { fontSize: 12, color: theme.textFade, marginBottom: 16 },
  list: { maxHeight: 300 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.gold, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.inkGreenDeep, fontWeight: '700' },
  rowName: { fontSize: 15, color: theme.textDark, fontWeight: '600' },
  rowSub: { fontSize: 11, color: theme.textFade },
  chip: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, borderWidth: 1.5, borderColor: theme.ticketShadow, borderRadius: theme.radius.sm, marginBottom: 8 },
  chipName: { fontSize: 14, color: theme.textDark },
  chipCount: { fontSize: 12, color: theme.textFade },
  back: { fontSize: 11, color: theme.textFade, marginBottom: 12 },
  summary: { backgroundColor: 'rgba(31,58,46,0.06)', borderRadius: theme.radius.md, padding: 14, marginBottom: 16 },
  summaryName: { fontSize: 17, fontWeight: '600', color: theme.textDark },
  summaryCourse: { fontSize: 12.5, color: theme.textFade, marginTop: 2 },
  cta: { backgroundColor: theme.stampRed, borderRadius: theme.radius.md, padding: 15, alignItems: 'center' },
  ctaText: { color: theme.ticket, fontSize: 13, fontWeight: '600' },
  close: { textAlign: 'center', color: theme.textFade, fontSize: 12, paddingTop: 14 },
});
