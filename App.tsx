import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const STORAGE_PERIODS = 'quietcycle:periods:v1';
const STORAGE_CONFIG = 'quietcycle:config:v1';
const STORAGE_NOTES = 'quietcycle:notes:v1';

type Period = { id: string; start: string; end?: string }; // YYYY-MM-DD
type Config = { cycleLen: number; periodLen: number };
type DayNote = { mood?: string; flow?: 'light' | 'medium' | 'heavy'; symptoms?: string };

function dkey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(d.getDate() + n);
  return x;
}

export default function App() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [config, setConfig] = useState<Config>({ cycleLen: 28, periodLen: 5 });
  const [notes, setNotes] = useState<Record<string, DayNote>>({});
  const [loaded, setLoaded] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [dayModal, setDayModal] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [p, c, n] = await Promise.all([
          AsyncStorage.getItem(STORAGE_PERIODS),
          AsyncStorage.getItem(STORAGE_CONFIG),
          AsyncStorage.getItem(STORAGE_NOTES),
        ]);
        if (p) setPeriods(JSON.parse(p));
        if (c) setConfig(JSON.parse(c));
        if (n) setNotes(JSON.parse(n));
      } catch (e) {
        console.warn('Load failed', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_PERIODS, JSON.stringify(periods)).catch(() => {});
  }, [periods, loaded]);
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_CONFIG, JSON.stringify(config)).catch(() => {});
  }, [config, loaded]);
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_NOTES, JSON.stringify(notes)).catch(() => {});
  }, [notes, loaded]);

  // Compute average cycle length from history. Filter outliers (gaps
  // outside the 18–40 day plausible range) BEFORE averaging so a single
  // long gap doesn't drag the whole prediction.
  const computedCycleLen = useMemo(() => {
    const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
    if (sorted.length < 2) return config.cycleLen;
    const gaps: number[] = [];
    // Use the most recent 6 gaps (~6 months) as a rolling estimate.
    const start = Math.max(1, sorted.length - 6);
    for (let i = start; i < sorted.length; i++) {
      const g = daysBetween(parseKey(sorted[i - 1].start), parseKey(sorted[i].start));
      if (g > 18 && g < 40) gaps.push(g);
    }
    if (gaps.length === 0) return config.cycleLen;
    return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }, [periods, config.cycleLen]);

  // Last period
  const lastPeriod = useMemo(() => {
    const sorted = [...periods].sort((a, b) => b.start.localeCompare(a.start));
    return sorted[0];
  }, [periods]);

  // Status line
  const status = useMemo(() => {
    if (!lastPeriod) return { dayOf: null as number | null, daysTo: null as number | null, isPeriod: false };
    const start = parseKey(lastPeriod.start);
    const end = lastPeriod.end ? parseKey(lastPeriod.end) : addDays(start, config.periodLen - 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOf = daysBetween(start, today) + 1;
    const isPeriod = today >= start && today <= end;
    const nextStart = addDays(start, computedCycleLen);
    const daysTo = daysBetween(today, nextStart);
    return { dayOf, daysTo, isPeriod };
  }, [lastPeriod, computedCycleLen, config.periodLen]);

  // Build month grid
  const month = useMemo(() => {
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const leading = first.getDay(); // 0 = Sunday
    const total = last.getDate();
    const rows: Date[][] = [];
    const current: Date[] = [];
    for (let i = 0; i < leading; i++) current.push(addDays(first, -(leading - i)));
    for (let d = 1; d <= total; d++) current.push(new Date(y, m, d));
    // Trailing days continue from the last day of the month.
    while (current.length % 7 !== 0) {
      current.push(addDays(last, current.length - leading - total + 1));
    }
    for (let i = 0; i < current.length; i += 7) rows.push(current.slice(i, i + 7));
    return rows;
  }, [viewMonth]);

  // Precompute a Set of logged period day-keys and predicted day-keys so
  // classifyDay is O(1) per cell instead of O(periods).
  const periodKeySet = useMemo(() => {
    const set = new Set<string>();
    for (const p of periods) {
      const start = parseKey(p.start);
      const end = p.end ? parseKey(p.end) : addDays(start, config.periodLen - 1);
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) set.add(dkey(d));
    }
    return set;
  }, [periods, config.periodLen]);

  const predictedKeySet = useMemo(() => {
    const set = new Set<string>();
    if (lastPeriod) {
      const start = parseKey(lastPeriod.start);
      const nextStart = addDays(start, computedCycleLen);
      const nextEnd = addDays(nextStart, config.periodLen - 1);
      for (let d = new Date(nextStart); d <= nextEnd; d = addDays(d, 1)) set.add(dkey(d));
    }
    return set;
  }, [lastPeriod, computedCycleLen, config.periodLen]);

  const classifyDay = useCallback(
    (d: Date) => {
      const k = dkey(d);
      if (periodKeySet.has(k)) return { kind: 'period' as const, key: k };
      if (predictedKeySet.has(k)) return { kind: 'predicted' as const, key: k };
      return { kind: 'normal' as const, key: k };
    },
    [periodKeySet, predictedKeySet],
  );

  const todayK = useMemo(() => dkey(new Date()), []);

  const togglePeriod = useCallback(
    (k: string) => {
      Haptics.selectionAsync().catch(() => {});
      const d = parseKey(k);
      // If today is already in a period, remove that period (or shrink); else start a new period.
      const existing = periods.find((p) => {
        const s = parseKey(p.start);
        const e = p.end ? parseKey(p.end) : addDays(s, config.periodLen - 1);
        return d >= s && d <= e;
      });
      if (existing) {
        Alert.alert(
          'Remove period?',
          `This will remove the period that started ${existing.start}.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: () => setPeriods((prev) => prev.filter((p) => p.id !== existing.id)),
            },
          ],
        );
      } else {
        // Freeze the end so retroactively changing periodLen in Settings
        // doesn't reshape past entries.
        const startDate = parseKey(k);
        const endDate = addDays(startDate, config.periodLen - 1);
        const next: Period = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          start: k,
          end: dkey(endDate),
        };
        setPeriods((prev) => [...prev, next]);
      }
    },
    [periods, config.periodLen],
  );

  const moveMonth = useCallback((delta: number) => {
    Haptics.selectionAsync().catch(() => {});
    setViewMonth((prev) => {
      const x = new Date(prev);
      x.setMonth(prev.getMonth() + delta);
      return x;
    });
  }, []);

  const monthLabel = viewMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Quiet <Text style={styles.brandItalic}>Cycle</Text></Text>
          <Text style={styles.brandSub}>Local-only. Nothing leaves this phone.</Text>
        </View>
        <Pressable
          onPress={() => setSettingsOpen(true)}
          style={({ pressed }) => [styles.settingsBtn, pressed && { opacity: 0.7 }]}
          hitSlop={8}
        >
          <Text style={styles.settingsText}>Settings</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.statusCard}>
          {!lastPeriod ? (
            <>
              <Text style={styles.statusBig}>Tap a day to start</Text>
              <Text style={styles.statusSub}>Log when your period starts. Quiet Cycle will begin predicting from there.</Text>
            </>
          ) : status.isPeriod ? (
            <>
              <Text style={styles.statusEyebrow}>PERIOD · DAY {status.dayOf}</Text>
              <Text style={styles.statusBig}>You're on day {status.dayOf}</Text>
              <Text style={styles.statusSub}>
                Average cycle: {computedCycleLen} days · Period length: {config.periodLen} days
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.statusEyebrow}>NEXT PERIOD</Text>
              <Text style={styles.statusBig}>
                {status.daysTo === 0 ? 'Expected today' : status.daysTo && status.daysTo > 0 ? `In ${status.daysTo} ${status.daysTo === 1 ? 'day' : 'days'}` : `${Math.abs(status.daysTo ?? 0)} days late`}
              </Text>
              <Text style={styles.statusSub}>
                Average cycle: {computedCycleLen} days · Period length: {config.periodLen} days
              </Text>
            </>
          )}
        </View>

        <View style={styles.calendarHeader}>
          <Pressable onPress={() => moveMonth(-1)} style={({ pressed }) => [styles.monthBtn, pressed && { opacity: 0.6 }]} hitSlop={8}>
            <Text style={styles.monthBtnText}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <Pressable onPress={() => moveMonth(1)} style={({ pressed }) => [styles.monthBtn, pressed && { opacity: 0.6 }]} hitSlop={8}>
            <Text style={styles.monthBtnText}>›</Text>
          </Pressable>
        </View>

        <View style={styles.weekRow}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
            <Text key={i} style={styles.weekLabel}>
              {w}
            </Text>
          ))}
        </View>

        <View style={styles.grid}>
          {month.map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((d, di) => {
                const inMonth = d.getMonth() === viewMonth.getMonth();
                const k = dkey(d);
                // Compare by date-string instead of getTime() so DST
                // transitions don't shift the "today" highlight.
                const isToday = k === todayK;
                const klass = classifyDay(d);
                const hasNote = !!notes[k];
                return (
                  <Pressable
                    key={di}
                    onPress={() => setDayModal(k)}
                    style={({ pressed }) => [
                      styles.cell,
                      !inMonth && styles.cellMuted,
                      klass.kind === 'period' && styles.cellPeriod,
                      klass.kind === 'predicted' && styles.cellPredicted,
                      isToday && styles.cellToday,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.cellText,
                        !inMonth && styles.cellTextMuted,
                        klass.kind === 'period' && styles.cellTextActive,
                        isToday && styles.cellTextToday,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                    {hasNote && <View style={styles.noteDot} />}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View style={styles.legend}>
          <LegendItem swatch={styles.legendPeriod} label="Logged period" />
          <LegendItem swatch={styles.legendPredicted} label="Predicted" />
        </View>
      </ScrollView>

      {/* Day modal */}
      <Modal visible={!!dayModal} transparent animationType="fade" onRequestClose={() => setDayModal(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setDayModal(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              {dayModal && (
                <DayEditor
                  date={dayModal}
                  classification={classifyDay(parseKey(dayModal)).kind}
                  note={notes[dayModal]}
                  onTogglePeriod={() => {
                    togglePeriod(dayModal);
                    setDayModal(null);
                  }}
                  onSaveNote={(n) => {
                    setNotes((prev) => {
                      const next = { ...prev };
                      if (!n || (!n.mood && !n.flow && !n.symptoms)) delete next[dayModal];
                      else next[dayModal] = n;
                      return next;
                    });
                    setDayModal(null);
                  }}
                  onClose={() => setDayModal(null)}
                />
              )}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Settings modal */}
      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setSettingsOpen(false)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <SettingsEditor
                config={config}
                onSave={(c) => {
                  setConfig(c);
                  setSettingsOpen(false);
                }}
                onClose={() => setSettingsOpen(false)}
              />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function LegendItem({ swatch, label }: { swatch: any; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, swatch]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

function DayEditor({
  date,
  classification,
  note,
  onTogglePeriod,
  onSaveNote,
  onClose,
}: {
  date: string;
  classification: 'period' | 'predicted' | 'normal';
  note?: DayNote;
  onTogglePeriod: () => void;
  onSaveNote: (n: DayNote) => void;
  onClose: () => void;
}) {
  const [flow, setFlow] = useState<DayNote['flow'] | undefined>(note?.flow);
  const [mood, setMood] = useState(note?.mood ?? '');
  const [symptoms, setSymptoms] = useState(note?.symptoms ?? '');
  const d = parseKey(date);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <View>
      <Text style={styles.modalTitle}>{label}</Text>
      <Text style={styles.modalSub}>
        {classification === 'period' ? 'Tap below to remove this period.' : classification === 'predicted' ? 'Predicted period day.' : 'Log a period start or add a note.'}
      </Text>

      <Pressable
        onPress={onTogglePeriod}
        style={({ pressed }) => [
          styles.periodBtn,
          classification === 'period' && styles.periodBtnRemove,
          pressed && { opacity: 0.85 },
        ]}
      >
        <Text style={styles.periodBtnText}>
          {classification === 'period' ? 'Remove period' : 'Log period starting here'}
        </Text>
      </Pressable>

      <Text style={styles.fieldLabel}>Flow</Text>
      <View style={styles.chipRow}>
        {(['light', 'medium', 'heavy'] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFlow(flow === f ? undefined : f)}
            style={({ pressed }) => [styles.chip, flow === f && styles.chipActive, pressed && { opacity: 0.85 }]}
          >
            <Text style={[styles.chipText, flow === f && styles.chipTextActive]}>{f}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.fieldLabel}>Mood</Text>
      <TextInput
        value={mood}
        onChangeText={setMood}
        placeholder="e.g. tired, fine, anxious"
        placeholderTextColor="#bbb"
        style={styles.input}
        maxLength={60}
      />

      <Text style={styles.fieldLabel}>Symptoms</Text>
      <TextInput
        value={symptoms}
        onChangeText={setSymptoms}
        placeholder="e.g. cramps, headache"
        placeholderTextColor="#bbb"
        style={styles.input}
        maxLength={120}
      />

      <View style={styles.modalActions}>
        <Pressable onPress={onClose} style={({ pressed }) => [styles.modalBtn, pressed && { opacity: 0.8 }]}>
          <Text style={styles.modalBtnText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => onSaveNote({ flow, mood: mood.trim() || undefined, symptoms: symptoms.trim() || undefined })}
          style={({ pressed }) => [styles.modalBtn, styles.modalBtnPrimary, pressed && { opacity: 0.85 }]}
        >
          <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>Save note</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SettingsEditor({
  config,
  onSave,
  onClose,
}: {
  config: Config;
  onSave: (c: Config) => void;
  onClose: () => void;
}) {
  const [cycle, setCycle] = useState(String(config.cycleLen));
  const [period, setPeriod] = useState(String(config.periodLen));
  return (
    <View>
      <Text style={styles.modalTitle}>Settings</Text>
      <Text style={styles.modalSub}>Quiet Cycle will refine cycle length automatically from your history. These are starting estimates.</Text>

      <Text style={styles.fieldLabel}>Average cycle length (days)</Text>
      <TextInput
        value={cycle}
        onChangeText={setCycle}
        keyboardType="number-pad"
        style={styles.input}
        maxLength={3}
      />

      <Text style={styles.fieldLabel}>Typical period length (days)</Text>
      <TextInput
        value={period}
        onChangeText={setPeriod}
        keyboardType="number-pad"
        style={styles.input}
        maxLength={3}
      />

      <View style={styles.modalActions}>
        <Pressable onPress={onClose} style={({ pressed }) => [styles.modalBtn, pressed && { opacity: 0.8 }]}>
          <Text style={styles.modalBtnText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            const c = Math.max(15, Math.min(45, parseInt(cycle, 10) || 28));
            const p = Math.max(1, Math.min(15, parseInt(period, 10) || 5));
            onSave({ cycleLen: c, periodLen: p });
          }}
          style={({ pressed }) => [styles.modalBtn, styles.modalBtnPrimary, pressed && { opacity: 0.85 }]}
        >
          <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fbf6f1' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  brand: { fontSize: 24, fontWeight: '700', color: '#3a1a28', letterSpacing: -0.3 },
  brandItalic: { fontStyle: 'italic', color: '#a8546a', fontWeight: '600' },
  brandSub: { fontSize: 11, color: '#8a7878', marginTop: 2, fontStyle: 'italic' },
  settingsBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  settingsText: { color: '#a8546a', fontSize: 13, fontWeight: '600' },

  scroll: { paddingHorizontal: 20, paddingBottom: 40 },

  statusCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 22,
    marginTop: 8, marginBottom: 24,
    borderWidth: 1, borderColor: '#f0dfe0',
  },
  statusEyebrow: { fontSize: 11, color: '#a8546a', letterSpacing: 2, fontWeight: '600', marginBottom: 6 },
  statusBig: { fontSize: 26, fontWeight: '600', color: '#3a1a28', marginBottom: 8, letterSpacing: -0.3 },
  statusSub: { fontSize: 13, color: '#8a7878', lineHeight: 18 },

  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  monthBtn: { paddingHorizontal: 14, paddingVertical: 6 },
  monthBtnText: { fontSize: 26, color: '#a8546a', lineHeight: 28 },
  monthLabel: { fontSize: 17, fontWeight: '600', color: '#3a1a28', letterSpacing: -0.2 },

  weekRow: { flexDirection: 'row' },
  weekLabel: { flex: 1, textAlign: 'center', fontSize: 11, color: '#a09494', fontWeight: '600', letterSpacing: 1 },

  grid: { marginTop: 8 },
  gridRow: { flexDirection: 'row', marginBottom: 4 },
  cell: {
    flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
    margin: 2, borderRadius: 999,
    backgroundColor: 'transparent',
  },
  cellMuted: { opacity: 0.25 },
  cellToday: { borderWidth: 1.5, borderColor: '#a8546a' },
  cellPeriod: { backgroundColor: '#a8546a' },
  cellPredicted: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: '#d3a3b0',
    backgroundColor: 'rgba(168, 84, 106, 0.08)',
  },
  cellText: { fontSize: 14, color: '#3a1a28', fontWeight: '500', fontVariant: ['tabular-nums'] },
  cellTextMuted: { color: '#8a7878' },
  cellTextActive: { color: '#fff', fontWeight: '600' },
  cellTextToday: { color: '#a8546a', fontWeight: '700' },
  noteDot: { position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: '#a8546a' },

  legend: { flexDirection: 'row', justifyContent: 'center', gap: 24, marginTop: 24 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 14, height: 14, borderRadius: 7 },
  legendPeriod: { backgroundColor: '#a8546a' },
  legendPredicted: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#d3a3b0', backgroundColor: 'rgba(168, 84, 106, 0.08)' },
  legendLabel: { fontSize: 12, color: '#7a6868' },

  modalBackdrop: { flex: 1 },
  modalBackdropTouch: { flex: 1, backgroundColor: 'rgba(40,20,30,0.4)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 22, maxHeight: '85%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#3a1a28', marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#8a7878', marginBottom: 16 },

  periodBtn: { backgroundColor: '#a8546a', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginBottom: 18 },
  periodBtnRemove: { backgroundColor: '#5a4046' },
  periodBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  fieldLabel: { fontSize: 11, color: '#a09494', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 14, marginBottom: 8 },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#f7eaea' },
  chipActive: { backgroundColor: '#a8546a' },
  chipText: { fontSize: 13, color: '#7a6868', fontWeight: '600', textTransform: 'capitalize' },
  chipTextActive: { color: '#fff' },
  input: {
    backgroundColor: '#f7eaea', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, color: '#3a1a28',
  },

  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: '#f7eaea' },
  modalBtnText: { fontSize: 14, fontWeight: '600', color: '#3a1a28' },
  modalBtnPrimary: { backgroundColor: '#a8546a' },
  modalBtnTextPrimary: { color: '#fff' },
});
