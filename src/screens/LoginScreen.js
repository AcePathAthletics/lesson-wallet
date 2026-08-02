import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { signInWithGoogle, signInWithEmail, signUpWithEmail } from '../lib/api.js';
import { createTranslator } from '../core/i18n.js';
import { theme } from '../theme.js';

export default function LoginScreen({ locale = 'en', onAuthed }) {
  const t = createTranslator(locale);
  const [role, setRole] = useState('teacher');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('logIn'); // 'logIn' | 'signUp'

  async function handleGoogle() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await signInWithGoogle();
      if (error) throw error;
      onAuthed?.({ role });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEmail() {
    setBusy(true);
    setError(null);
    try {
      const { error } =
        mode === 'signUp'
          ? await signUpWithEmail(email, password, role)
          : await signInWithEmail(email, password);
      if (error) throw error;
      onAuthed?.({ role });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.logo}>{t('app.name')}</Text>
      <Text style={styles.tag}>{t('app.tagline')}</Text>

      <Text style={styles.chooseLabel}>{t('role.choose')}</Text>
      <View style={styles.roleRow}>
        {['teacher', 'student'].map((r) => (
          <Pressable
            key={r}
            onPress={() => setRole(r)}
            style={[styles.rolePill, role === r && styles.rolePillActive]}
          >
            <Text style={[styles.roleText, role === r && styles.roleTextActive]}>
              {t(`role.${r}`)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={styles.googleBtn} onPress={handleGoogle} disabled={busy}>
        {busy ? (
          <ActivityIndicator color={theme.textDark} />
        ) : (
          <Text style={styles.googleText}>{t('auth.continueGoogle')}</Text>
        )}
      </Pressable>

      <Text style={styles.divider}>{t('auth.orEmail')}</Text>

      <TextInput
        style={styles.field}
        placeholder={t('auth.email')}
        placeholderTextColor="rgba(239,231,211,0.35)"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.field}
        placeholder={t('auth.password')}
        placeholderTextColor="rgba(239,231,211,0.35)"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.loginBtn} onPress={handleEmail} disabled={busy}>
        <Text style={styles.loginText}>{t(mode === 'signUp' ? 'auth.signUp' : 'auth.logIn')}</Text>
      </Pressable>

      <Pressable onPress={() => setMode(mode === 'signUp' ? 'logIn' : 'signUp')}>
        <Text style={styles.switchMode}>
          {t(mode === 'signUp' ? 'auth.haveAccount' : 'auth.noAccount')}
        </Text>
      </Pressable>

      <Text style={styles.footnote}>{t('auth.terms')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.inkGreenDeep, justifyContent: 'center', padding: 26 },
  logo: { fontSize: 30, color: theme.ticket, textAlign: 'center', fontWeight: '600' },
  tag: { fontSize: 12, color: 'rgba(239,231,211,0.45)', textAlign: 'center', marginBottom: 30 },
  chooseLabel: { fontSize: 11, color: theme.goldSoft, textAlign: 'center', marginBottom: 8 },
  roleRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 22 },
  rolePill: {
    paddingVertical: 8, paddingHorizontal: 18, borderRadius: theme.radius.pill,
    borderWidth: 1, borderColor: 'rgba(239,231,211,0.25)',
  },
  rolePillActive: { backgroundColor: theme.gold, borderColor: theme.gold },
  roleText: { color: 'rgba(239,231,211,0.55)', fontSize: 12 },
  roleTextActive: { color: theme.inkGreenDeep, fontWeight: '700' },
  googleBtn: {
    backgroundColor: theme.ticket, borderRadius: theme.radius.md, padding: 14,
    alignItems: 'center', marginBottom: 16,
  },
  googleText: { color: '#3c3c3c', fontWeight: '600', fontSize: 14 },
  divider: { color: 'rgba(239,231,211,0.3)', fontSize: 10, textAlign: 'center', marginBottom: 14 },
  field: {
    backgroundColor: 'rgba(239,231,211,0.08)', borderWidth: 1,
    borderColor: 'rgba(239,231,211,0.15)', borderRadius: theme.radius.sm,
    padding: 12, color: theme.ticket, marginBottom: 10,
  },
  error: { color: theme.stampRed, fontSize: 12, marginBottom: 8, textAlign: 'center' },
  loginBtn: { backgroundColor: theme.stampRed, borderRadius: theme.radius.md, padding: 14, alignItems: 'center' },
  loginText: { color: theme.ticket, fontSize: 13, fontWeight: '600' },
  switchMode: { color: theme.goldSoft, fontSize: 12, textAlign: 'center', marginTop: 14 },
  footnote: { color: 'rgba(239,231,211,0.35)', fontSize: 11, textAlign: 'center', marginTop: 22 },
});
