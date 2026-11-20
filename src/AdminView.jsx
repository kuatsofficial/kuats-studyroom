import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { isValidStudentId } from './utils';
import {
  ShieldCheck,
  Users,
  Calendar,
  ListChecks,
  CheckCircle2,
  XCircle,
  UserPlus,
  RefreshCw,
  LogOut,
  AlertCircle,
  Search,
  Trash2,
  Ban,
  PlusCircle,
} from 'lucide-react';

const ADMIN_EMAILS = ['kuats.official@gmail.com'];

function formatHHMM(timeStr) {
  if (!timeStr) return '00:00';
  return String(timeStr).slice(0, 5);
}

// KST 기준 YYYY-MM-DD 포맷
function formatKSTDate(offsetDays = 0) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const label = `${mm}/${dd} (${['일', '월', '화', '수', '목', '금', '토'][kst.getUTCDay()]})`;
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    label,
    isToday: offsetDays === 0,
  };
}

// "YYYY-MM-DD"에 n일 더하기 (UTC 기준 안전 계산)
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 시작일~종료일 사이의 모든 YYYY-MM-DD 배열 생성
function getDatesBetween(startStr, endStr) {
  const dates = [];
  let cur = startStr;
  while (cur <= endStr) {
    dates.push(cur);
    cur = addDaysToDateStr(cur, 1);
  }
  return dates;
}

// 연속된 날짜 문자열 배열을 기간({ start, end, count }) 배열로 묶기
function groupConsecutiveDates(sortedDateStrs) {
  if (!sortedDateStrs || sortedDateStrs.length === 0) return [];
  const ranges = [];
  let start = sortedDateStrs[0];
  let prev = sortedDateStrs[0];
  let count = 1;

  for (let i = 1; i < sortedDateStrs.length; i++) {
    const cur = sortedDateStrs[i];
    if (addDaysToDateStr(prev, 1) === cur) {
      prev = cur;
      count += 1;
    } else {
      ranges.push({ start, end: prev, count });
      start = cur;
      prev = cur;
      count = 1;
    }
  }
  ranges.push({ start, end: prev, count });
  return ranges;
}

// 과거 7일 전 ~ 오늘 ~ 7일 후 날짜 목록 생성 (예약 현황 조회용)
function getAdminRangeDays() {
  const list = [];
  for (let offset = -7; offset <= 7; offset++) {
    list.push(formatKSTDate(offset));
  }
  return list;
}

export default function AdminView({ onSwitchToStudent, onBack, onExitAdmin }) {
  const handleGoStudent = () => {
    if (typeof onSwitchToStudent === 'function') {
      onSwitchToStudent();
    } else if (typeof onBack === 'function') {
      onBack();
    } else if (typeof onExitAdmin === 'function') {
      onExitAdmin();
    } else {
      window.location.href = '/';
    }
  };

  const [sessionUser, setSessionUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [activeTab, setActiveTab] = useState('members');

  // 회원 관리 상태
  const [members, setMembers] = useState([]);
  const [memberFilter, setMemberFilter] = useState('all'); // 'all' | 'pending' | 'associate' | 'regular' | 'revoked'
  const [searchQuery, setSearchQuery] = useState('');
  const [quickStudentId, setQuickStudentId] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(false);

  const adminRangeDays = useMemo(() => getAdminRangeDays(), []);
  const todayStr = useMemo(() => formatKSTDate(0).dateStr, []);

  // 열람실(시험기간) 기간 예약 상태 (오늘 ~ 약 5개월 후(+150일))
  const minConfigurableDate = todayStr;
  const maxConfigurableDate = useMemo(() => formatKSTDate(150).dateStr, []);
  const [scheduledReadingDates, setScheduledReadingDates] = useState([]);
  const [periodStartDate, setPeriodStartDate] = useState(todayStr);
  const [periodEndDate, setPeriodEndDate] = useState(formatKSTDate(2).dateStr);
  const [applyingPeriod, setApplyingPeriod] = useState(false);
  const [loadingModes, setLoadingModes] = useState(false);

  // 예약 현황 상태
  const [reservations, setReservations] = useState([]);
  const [selectedResDate, setSelectedResDate] = useState(todayStr);
  const [hideCancelled, setHideCancelled] = useState(true);
  const [loadingRes, setLoadingRes] = useState(false);

  const scheduledPeriods = useMemo(
    () => groupConsecutiveDates(scheduledReadingDates),
    [scheduledReadingDates]
  );

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const user = data?.session?.user || null;
      if (user && ADMIN_EMAILS.includes(user.email)) {
        setSessionUser(user);
      }
      setAuthChecking(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user || null;
      if (user && ADMIN_EMAILS.includes(user.email)) {
        setSessionUser(user);
      } else {
        setSessionUser(null);
      }
    });

    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setLoginError('');

    const cleanEmail = email.trim().toLowerCase();
    if (!ADMIN_EMAILS.includes(cleanEmail)) {
      setLoginError('등록된 학생회 관리자 계정이 아닙니다.');
      return;
    }

    setLoginLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error) throw error;
      setSessionUser(data.user);
    } catch (err) {
      setLoginError('로그인 실패: 이메일 또는 비밀번호를 확인해 주세요.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleAdminLogout = async () => {
    await supabase.auth.signOut();
    setSessionUser(null);
  };

  const fetchMembers = async () => {
    setLoadingMembers(true);
    try {
      const { data, error } = await supabase
        .from('member_profiles')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setMembers(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMembers(false);
    }
  };

  // 오늘 이후 예약된 열람실(시험기간) 날짜 목록 불러오기
  const fetchScheduledReadingPeriods = async () => {
    setLoadingModes(true);
    try {
      const { data, error } = await supabase
        .from('daily_modes')
        .select('date')
        .eq('mode', 'reading_room')
        .gte('date', todayStr)
        .order('date', { ascending: true });
      if (error) throw error;
      setScheduledReadingDates((data || []).map((row) => row.date));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingModes(false);
    }
  };

  // 일주일(7일) 지난 예약 기록 자동 삭제 + 선택 날짜 예약 내역 조회
  const fetchReservationsByDate = async (targetDate = selectedResDate) => {
    setLoadingRes(true);
    try {
      const sevenDaysAgoStr = formatKSTDate(-7).dateStr;
      await supabase.from('reservations').delete().lt('date', sevenDaysAgoStr);

      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('date', targetDate)
        .order('start_time', { ascending: true });
      if (error) throw error;
      setReservations(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingRes(false);
    }
  };

  useEffect(() => {
    if (!sessionUser) return;
    fetchMembers();
    fetchScheduledReadingPeriods();
    fetchReservationsByDate(selectedResDate);
  }, [sessionUser]);

  useEffect(() => {
    if (sessionUser) {
      fetchReservationsByDate(selectedResDate);
    }
  }, [selectedResDate]);

  // 회원 등급/자격 변경
  const handleUpdateMemberStatus = async (studentId, newStatus, confirmMsg = '') => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const { error } = await supabase
        .from('member_profiles')
        .update({ status: newStatus })
        .eq('student_id', studentId);
      if (error) throw error;
      fetchMembers();
    } catch (err) {
      alert('상태 변경 오류: ' + err.message);
    }
  };

  // 학번으로 빠른 정회원 승격
  const handleQuickPromoteRegular = async (e) => {
    e.preventDefault();
    const cleanId = quickStudentId.trim();
    if (!isValidStudentId(cleanId)) {
      alert('학번은 숫자 10자리로 입력해 주세요. (예: 2026170123)');
      return;
    }

    try {
      const { data: target } = await supabase
        .from('member_profiles')
        .select('student_id, name')
        .eq('student_id', cleanId)
        .maybeSingle();

      if (!target) {
        alert('먼저 회원가입 신청을 완료한 학번만 승격할 수 있습니다.');
        return;
      }

      const { error } = await supabase
        .from('member_profiles')
        .update({ status: 'regular' })
        .eq('student_id', cleanId);
      if (error) throw error;

      alert(`${target.name} (${cleanId}) 회원이 정회원으로 승격되었습니다.`);
      setQuickStudentId('');
      fetchMembers();
    } catch (err) {
      alert('승격 처리 오류: ' + err.message);
    }
  };

  // 열람실(시험기간) 기간 추가 예약
  const handleAddReadingRoomPeriod = async (e) => {
    e.preventDefault();
    if (!periodStartDate || !periodEndDate) {
      alert('시작일과 종료일을 모두 선택해 주세요.');
      return;
    }
    if (periodStartDate > periodEndDate) {
      alert('시작일이 종료일보다 늦을 수 없습니다.');
      return;
    }
    if (periodStartDate < minConfigurableDate || periodEndDate > maxConfigurableDate) {
      alert(
        `설정은 ${minConfigurableDate} ~ ${maxConfigurableDate} (오늘 ~ 약 5개월 후) 범위 내에서 가능합니다.`
      );
      return;
    }

    setApplyingPeriod(true);
    try {
      const dates = getDatesBetween(periodStartDate, periodEndDate);
      const rows = dates.map((dateStr) => ({
        date: dateStr,
        mode: 'reading_room',
      }));

      const { error } = await supabase
        .from('daily_modes')
        .upsert(rows, { onConflict: 'date' });
      if (error) throw error;

      await fetchScheduledReadingPeriods();
      alert(`${periodStartDate} ~ ${periodEndDate} (${dates.length}일간) 열람실(시험기간) 일정이 예약되었습니다.`);
    } catch (err) {
      alert('열람실 기간 등록 실패: ' + err.message);
    } finally {
      setApplyingPeriod(false);
    }
  };

  // 예약된 열람실 기간 삭제 (기본 스터디룸으로 복원)
  const handleRemoveReadingRoomPeriod = async (period) => {
    if (
      !window.confirm(
        `${period.start} ~ ${period.end} (${period.count}일간) 열람실(시험기간) 예약을 취소하고 스터디룸으로 되돌릴까요?`
      )
    ) {
      return;
    }

    try {
      const dates = getDatesBetween(period.start, period.end);
      const rows = dates.map((dateStr) => ({
        date: dateStr,
        mode: 'study_room',
      }));

      const { error } = await supabase
        .from('daily_modes')
        .upsert(rows, { onConflict: 'date' });
      if (error) throw error;

      await fetchScheduledReadingPeriods();
    } catch (err) {
      alert('일정 삭제 실패: ' + err.message);
    }
  };

  // 관리자 직권 예약 취소
  const handleAdminCancelReservation = async (res) => {
    if (
      !window.confirm(
        `[${res.student_name} / ${res.seat_id} / ${formatHHMM(res.start_time)}~${formatHHMM(
          res.end_time
        )}] 예약을 관리자 권한으로 취소할까요?`
      )
    ) {
      return;
    }

    try {
      const { error } = await supabase
        .from('reservations')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', res.id);
      if (error) throw error;
      fetchReservationsByDate(selectedResDate);
    } catch (err) {
      alert('예약 취소 실패: ' + err.message);
    }
  };

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      if (memberFilter !== 'all' && m.status !== memberFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        m.name?.toLowerCase().includes(q) ||
        m.student_id?.includes(q) ||
        m.department?.toLowerCase().includes(q)
      );
    });
  }, [members, memberFilter, searchQuery]);

  const pendingCount = useMemo(
    () => members.filter((m) => m.status === 'pending').length,
    [members]
  );

  const visibleReservations = useMemo(() => {
    if (!hideCancelled) return reservations;
    return reservations.filter((r) => r.status !== 'cancelled');
  }, [reservations, hideCancelled]);

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white text-sm">
        관리자 인증 확인 중...
      </div>
    );
  }

  if (!sessionUser) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col justify-center items-center px-4 py-6">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-6 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-rose-600" />
              <h1 className="text-lg sm:text-xl font-extrabold text-slate-900">
                학생회 관리자 로그인
              </h1>
            </div>
            <button
              type="button"
              onClick={handleGoStudent}
              className="min-h-[36px] px-2.5 text-xs font-bold text-slate-500 hover:text-slate-800 bg-slate-100 rounded-xl"
            >
              ← 학생 화면
            </button>
          </div>

          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">관리자 이메일</label>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="관리자 이메일을 입력하세요"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-slate-900 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">비밀번호</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="비밀번호 입력"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-slate-900 focus:outline-none"
              />
            </div>

            {loginError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full min-h-[48px] py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-sm transition"
            >
              {loginLoading ? '로그인 중...' : '관리자 대시보드 입장'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 pb-16">
      <header className="bg-slate-900 text-white sticky top-0 z-30 shadow-sm">
        <div className="max-w-5xl mx-auto px-3.5 sm:px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-5 h-5 text-rose-400 shrink-0" />
            <h1 className="text-base sm:text-lg font-extrabold truncate">편입연 관리자 콘솔</h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleGoStudent}
              className="min-h-[36px] px-3 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl"
            >
              학생 화면
            </button>
            <button
              onClick={handleAdminLogout}
              className="min-h-[36px] px-3 py-1.5 text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white rounded-xl flex items-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" /> 로그아웃
            </button>
          </div>
        </div>

        <div className="bg-slate-800/90 border-t border-slate-700">
          <div className="max-w-5xl mx-auto px-3.5 sm:px-4 grid grid-cols-3 gap-1 py-1.5">
            <button
              type="button"
              onClick={() => setActiveTab('members')}
              className={`min-h-[42px] rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'members'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>회원 관리</span>
              {pendingCount > 0 && (
                <span className="px-1.5 py-0.2 bg-rose-500 text-white text-[10px] rounded-full">
                  {pendingCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('modes')}
              className={`min-h-[42px] rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'modes'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>공간 지정</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('reservations')}
              className={`min-h-[42px] rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'reservations'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <ListChecks className="w-4 h-4" />
              <span>예약 현황</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3.5 sm:px-4 mt-4 sm:mt-6 space-y-4">
        {/* ================= TAB 1: 회원 관리 ================= */}
        {activeTab === 'members' && (
          <>
            <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-sm font-extrabold text-slate-800 mb-2 flex items-center gap-1.5">
                <UserPlus className="w-4 h-4 text-indigo-600" /> 학번으로 빠른 정회원 승격
              </h2>
              <form onSubmit={handleQuickPromoteRegular} className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  placeholder="2026170123"
                  value={quickStudentId}
                  onChange={(e) => setQuickStudentId(e.target.value.replace(/[^0-9]/g, ''))}
                  className="flex-1 min-h-[44px] px-3.5 py-2 text-base sm:text-sm border border-slate-300 rounded-xl tracking-wider"
                />
                <button
                  type="submit"
                  className="min-h-[44px] px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shrink-0"
                >
                  정회원 승격
                </button>
              </form>
            </section>

            <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 space-y-3.5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-extrabold text-slate-800">
                  회원 목록 ({filteredMembers.length}명)
                </h2>
                <button
                  onClick={fetchMembers}
                  className="min-h-[34px] px-2.5 text-xs font-bold bg-slate-100 text-slate-600 rounded-lg flex items-center gap-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 새로고침
                </button>
              </div>

              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {[
                  { key: 'all', label: `전체 (${members.length})` },
                  { key: 'pending', label: `승인대기 (${pendingCount})` },
                  {
                    key: 'associate',
                    label: `준회원 (${members.filter((m) => m.status === 'associate').length})`,
                  },
                  {
                    key: 'regular',
                    label: `정회원 (${members.filter((m) => m.status === 'regular').length})`,
                  },
                  {
                    key: 'revoked',
                    label: `박탈 (${members.filter((m) => m.status === 'revoked').length})`,
                  },
                ].map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setMemberFilter(f.key)}
                    className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 border transition ${
                      memberFilter === f.key
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="이름, 학번, 학과로 검색"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full min-h-[42px] pl-9 pr-3.5 py-2 text-base sm:text-sm border border-slate-300 rounded-xl"
                />
              </div>

              {loadingMembers ? (
                <div className="py-8 text-center text-xs text-slate-400">불러오는 중...</div>
              ) : filteredMembers.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  조건에 맞는 회원이 없습니다.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredMembers.map((m) => {
                    const isRegularMember = m.status === 'regular';
                    return (
                      <div
                        key={m.student_id}
                        className={`p-3.5 rounded-2xl border space-y-2.5 ${
                          isRegularMember
                            ? 'border-indigo-200 bg-indigo-50/40'
                            : 'border-slate-200 bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`font-extrabold text-slate-900 ${
                                  isRegularMember ? 'text-base sm:text-lg' : 'text-sm'
                                }`}
                              >
                                {m.name}
                              </span>
                              <span className="text-xs font-semibold text-slate-500">
                                {m.student_id}
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 mt-0.5">{m.department}</p>
                          </div>

                          {isRegularMember ? (
                            <span className="px-3.5 py-1.5 rounded-xl bg-indigo-600 text-white text-sm font-black shadow-xs tracking-wide">
                              정회원
                            </span>
                          ) : (
                            <span
                              className={`px-2.5 py-1 rounded-full text-[11px] font-extrabold ${
                                m.status === 'pending'
                                  ? 'bg-amber-100 text-amber-800'
                                  : m.status === 'associate'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : m.status === 'revoked'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-rose-100 text-rose-800'
                              }`}
                            >
                              {m.status === 'pending'
                                ? '승인 대기'
                                : m.status === 'associate'
                                ? '준회원'
                                : m.status === 'revoked'
                                ? '자격 박탈'
                                : '반려됨'}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          {m.status === 'pending' && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleUpdateMemberStatus(m.student_id, 'associate')}
                                className="flex-1 sm:flex-initial min-h-[40px] px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> 준회원 승인
                              </button>
                              <button
                                type="button"
                                onClick={() => handleUpdateMemberStatus(m.student_id, 'rejected')}
                                className="flex-1 sm:flex-initial min-h-[40px] px-3 py-2 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                              >
                                <XCircle className="w-3.5 h-3.5" /> 반려
                              </button>
                            </>
                          )}

                          {m.status === 'associate' && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleUpdateMemberStatus(m.student_id, 'regular')}
                                className="flex-1 sm:flex-initial min-h-[40px] px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl"
                              >
                                정회원 승격
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleUpdateMemberStatus(
                                    m.student_id,
                                    'revoked',
                                    `${m.name} (${m.student_id}) 회원의 자격을 박탈할까요?`
                                  )
                                }
                                className="min-h-[40px] px-3 py-2 bg-white border border-red-300 hover:bg-red-50 text-red-600 text-xs font-bold rounded-xl flex items-center gap-1"
                              >
                                <Ban className="w-3.5 h-3.5" /> 박탈
                              </button>
                            </>
                          )}

                          {isRegularMember && (
                            <div className="w-full flex items-center justify-between gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={() =>
                                  handleUpdateMemberStatus(
                                    m.student_id,
                                    'revoked',
                                    `${m.name} (${m.student_id}) 정회원의 자격을 박탈할까요?`
                                  )
                                }
                                className="min-h-[34px] px-2.5 py-1 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-[11px] font-bold rounded-lg flex items-center gap-1"
                              >
                                <Ban className="w-3 h-3" /> 자격 박탈
                              </button>

                              <button
                                type="button"
                                onClick={() => handleUpdateMemberStatus(m.student_id, 'associate')}
                                className="min-h-[30px] px-2.5 py-1 bg-slate-200/80 hover:bg-slate-300 text-slate-600 text-[11px] font-semibold rounded-lg"
                              >
                                준회원으로 변경
                              </button>
                            </div>
                          )}

                          {(m.status === 'rejected' || m.status === 'revoked') && (
                            <button
                              type="button"
                              onClick={() => handleUpdateMemberStatus(m.student_id, 'associate')}
                              className="w-full sm:w-auto min-h-[40px] px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl"
                            >
                              준회원으로 복구
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {/* ================= TAB 2: 열람실(시험기간) 기간 예약 관리 ================= */}
        {activeTab === 'modes' && (
          <>
            <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 space-y-3">
              <div>
                <h2 className="text-sm font-extrabold text-slate-800 flex items-center gap-1.5">
                  <PlusCircle className="w-4 h-4 text-emerald-600" /> 열람실(시험기간) 기간 예약하기
                </h2>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  평소에는 기본 <strong>스터디룸</strong>으로 운영되며, 아래에서 기간을 예약해 두면 해당 기간만 자동으로 <strong>열람실(시험기간)</strong>로 전환됩니다. (앞으로 약 5개월 후까지 미리 예약 가능)
                </p>
              </div>

              <form onSubmit={handleAddReadingRoomPeriod} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      열람실 시작일
                    </label>
                    <input
                      type="date"
                      min={minConfigurableDate}
                      max={maxConfigurableDate}
                      value={periodStartDate}
                      onChange={(e) => setPeriodStartDate(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-xl bg-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      열람실 종료일
                    </label>
                    <input
                      type="date"
                      min={minConfigurableDate}
                      max={maxConfigurableDate}
                      value={periodEndDate}
                      onChange={(e) => setPeriodEndDate(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-xl bg-white"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={applyingPeriod}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition"
                >
                  {applyingPeriod ? '예약 등록 중...' : '열람실(시험기간) 기간 예약 추가'}
                </button>
              </form>
            </section>

            <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-extrabold text-slate-800">
                    예약된 열람실(시험기간) 일정 ({scheduledPeriods.length}건)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    목록에 없는 날짜는 모두 기본 <strong>스터디룸</strong>으로 운영됩니다.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={fetchScheduledReadingPeriods}
                  className="min-h-[34px] px-2.5 text-xs font-bold bg-slate-100 text-slate-600 rounded-lg flex items-center gap-1 shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 새로고침
                </button>
              </div>

              {loadingModes ? (
                <div className="py-8 text-center text-xs text-slate-400">불러오는 중...</div>
              ) : scheduledPeriods.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                  현재 예약된 열람실(시험기간) 일정이 없습니다. (모든 날짜 스터디룸 운영 중)
                </div>
              ) : (
                <div className="space-y-2.5">
                  {scheduledPeriods.map((period) => (
                    <div
                      key={`${period.start}_${period.end}`}
                      className="p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[11px] font-extrabold">
                            열람실(시험기간)
                          </span>
                          <span className="text-sm font-extrabold text-slate-900">
                            {period.start} ~ {period.end}
                          </span>
                          <span className="text-xs font-bold text-emerald-800">
                            ({period.count}일간)
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemoveReadingRoomPeriod(period)}
                        className="w-full sm:w-auto min-h-[38px] px-3.5 py-2 bg-white border border-rose-300 hover:bg-rose-50 text-rose-600 text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> 일정 삭제
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* ================= TAB 3: 예약 현황 ================= */}
        {activeTab === 'reservations' && (
          <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-extrabold text-slate-800">
                  예약 현황 ({visibleReservations.length}건)
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  과거 7일 기록까지 조회 가능하며, 7일이 지난 기록은 자동 삭제됩니다.
                </p>
              </div>
              <button
                onClick={() => fetchReservationsByDate(selectedResDate)}
                className="min-h-[34px] px-2.5 text-xs font-bold bg-slate-100 text-slate-600 rounded-lg flex items-center gap-1 shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" /> 새로고침
              </button>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1 snap-x">
              {adminRangeDays.map((d) => {
                const active = d.dateStr === selectedResDate;
                return (
                  <button
                    key={d.dateStr}
                    type="button"
                    onClick={() => setSelectedResDate(d.dateStr)}
                    className={`snap-start min-w-[78px] min-h-[44px] px-2.5 py-2 rounded-xl text-xs font-bold border shrink-0 transition ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    <div>{d.label}</div>
                    {d.isToday && (
                      <div className={`text-[10px] ${active ? 'text-emerald-300' : 'text-emerald-600'}`}>
                        오늘
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 취소된 예약 숨기기 체크박스 */}
            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideCancelled}
                onChange={(e) => setHideCancelled(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span className="text-xs font-bold text-slate-700">
                취소된 예약 숨기기
              </span>
            </label>

            {loadingRes ? (
              <div className="py-8 text-center text-xs text-slate-400">불러오는 중...</div>
            ) : visibleReservations.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                표시할 예약 내역이 없습니다.
              </div>
            ) : (
              <div className="space-y-2.5">
                {visibleReservations.map((res) => (
                  <div
                    key={res.id}
                    className="p-3.5 rounded-2xl border border-slate-200 bg-slate-50 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-white text-xs font-bold">
                          {res.mode === 'reading_room'
                            ? `열람실(시험기간) ${res.seat_id}`
                            : '스터디룸'}
                        </span>
                        <span className="text-sm font-extrabold text-slate-900">
                          {formatHHMM(res.start_time)} ~ {formatHHMM(res.end_time)}
                        </span>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                          res.status === 'active'
                            ? 'bg-emerald-100 text-emerald-700'
                            : res.status === 'completed'
                            ? 'bg-slate-200 text-slate-700'
                            : 'bg-rose-100 text-rose-700'
                        }`}
                      >
                        {res.status === 'active'
                          ? '예약중'
                          : res.status === 'completed'
                          ? '퇴실완료'
                          : '취소됨'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-700">
                      <strong>대표자:</strong> {res.student_name} ({res.student_id})
                    </div>

                    {res.mode === 'study_room' && (
                      <div className="text-xs text-slate-600 space-y-0.5">
                        <div>
                          <strong>인원/목적:</strong> {res.total_headcount}명 · {res.purpose}
                        </div>
                        {Array.isArray(res.companion_ids) && res.companion_ids.length > 0 && (
                          <div>
                            <strong>동반자 학번:</strong> {res.companion_ids.join(', ')}
                          </div>
                        )}
                      </div>
                    )}

                    {res.status === 'active' && (
                      <div className="pt-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleAdminCancelReservation(res)}
                          className="w-full sm:w-auto min-h-[40px] px-3.5 py-2 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> 관리자 직권 취소
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}