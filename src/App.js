import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { getLocales } from 'expo-localization';

import LoginScreen from './screens/LoginScreen.js';
import TeacherHomeScreen from './screens/TeacherHomeScreen.js';
import ProfileScreen from './screens/ProfileScreen.js';
import LogLessonSheet from './screens/LogLessonSheet.js';
import WalletScreen from './screens/student/WalletScreen.js';
import { getCurrentUser, getProfile, fetchRoster, supabase } from './lib/api.js';
import { resolveLocale, createTranslator } from './core/i18n.js';
import { theme } from './theme.js';

const Tab = createBottomTabNavigator();

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [roster, setRoster] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [locale, setLocale] = useState(resolveLocale(getLocales?.()[0]?.languageTag));

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    (async () => {
      const user = await getCurrentUser();
      const p = await getProfile(user.id);
      setProfile(p);
      setLocale(p.locale ?? locale);
      if (p.role === 'teacher') setRoster(await fetchRoster(user.id));
    })();
  }, [session]);

  if (!session || !profile) {
    return <LoginScreen locale={locale} onAuthed={() => {}} />;
  }

  const t = createTranslator(locale);
  const isTeacher = profile.role === 'teacher';

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: { backgroundColor: theme.inkGreenDeep, borderTopColor: 'rgba(239,231,211,0.08)' },
          tabBarActiveTintColor: theme.gold,
          tabBarInactiveTintColor: 'rgba(239,231,211,0.35)',
        }}
      >
        {isTeacher ? (
          <Tab.Screen name="home" options={{ title: t('nav.home') }}>
            {() => (
              <TeacherHomeScreen
                locale={locale}
                teacherId={profile.id}
                onOpenLog={() => setShowLog(true)}
              />
            )}
          </Tab.Screen>
        ) : (
          <Tab.Screen name="wallet" options={{ title: t('nav.home') }}>
            {() => (
              <WalletScreen locale={locale} studentId={profile.id} studentName={profile.name} />
            )}
          </Tab.Screen>
        )}
        <Tab.Screen name="profile" options={{ title: t('nav.profile') }}>
          {() => (
            <ProfileScreen
              locale={locale}
              user={profile}
              isTeacher={isTeacher}
              onSignedOut={() => setSession(null)}
            />
          )}
        </Tab.Screen>
      </Tab.Navigator>

      {isTeacher && (
        <LogLessonSheet
          visible={showLog}
          locale={locale}
          roster={roster}
          onClose={() => setShowLog(false)}
          onLogged={async () => setRoster(await fetchRoster(profile.id))}
        />
      )}
    </NavigationContainer>
  );
}
