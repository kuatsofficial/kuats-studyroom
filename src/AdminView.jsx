import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { getTodayKST, isValidStudentId } from './utils';
import {
  ShieldCheck,
  Calendar,
  Users,
  ListChecks,
  UserPlus,
  Trash2,
  AlertTriangle,
  LogOut,
  ArrowLeft,
} from 'lucide-react';

// 관리자 허용 이메일 목록 (일반 학생 계정으로 관리자 페이지 접근 차단)
const ADMIN_EMAILS = ['kuats.official@gmail.com'];

// 'YYYY-MM-DD' 시작일 ~ 종료일 사이의 모든 날짜 배열 생성
function getDatesInRange(startStr, endStr) {
  if (!startStr) return [];
  const effectiveEnd = endStr && endStr >= startStr ? endStr : startStr;
  const dates = [];
  const current = new Date(`${startStr}T00:00:00`);
  const last = new Date(`${effectiveEnd}T00:00:00`);

  while (current <= last) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

export default function AdminView({ onBackToStudent }) {
  // 1. Supabase Auth 관리자 세션 상태
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // 2. 관리자 대시보드 탭 ('schedule' | 'members' | 'reservations')
  const [activeTab, setActiveTab] = useState('schedule');

  // 3. 기간별 모드 스케줄링 상태 (기본값은 항상 스터디룸 모드)
  const [rangeStartDate, setRangeStartDate] = useState(getTodayKST());
  const [rangeEndDate, setRangeEndDate] = useState(getTodayKST());
  const [dailyModes, setDailyModes] = useState([]);
  const [modeSaving, setModeSaving] = useState(false);
  const [conflictModal, setConflictModal] = useState(null);

  // 4. 가입 승인 및 회원 등급 관리 상태
  const [memberProfiles, setMemberProfiles] = useState([]);
  const [quickStudentId, setQuickStudentId] = useState('');

  // 5. 전체 예약 내역 조회 상태
  const [filterDate, setFilterDate] = useState(getTodayKST());
  const [allReservations, setAllReservations] = useState([]);

  const isAllowedAdmin = (userObj) => {
    const userEmail = userObj?.email?.toLowerCase() || '';
    return ADMIN_EMAILS.includes(userEmail);
  };

  // 초기 세션 확인 (관리자 이메일이 아니면 자동 로그아웃)
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session && !isAllowedAdmin(session.user)) {
        await supabase.auth.signOut();
        setSession(null);
        return;
      }
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session && !isAllowedAdmin(session.user)) {
        await supabase.auth.signOut();
        setSession(null);
        return;
      }
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // 로그인 후 데이터 불러오기
  useEffect(() => {
    if (session) {
      fetchDailyModes();
      fetchMemberProfiles();
      fetchReservationsByDate(filterDate);
    }
  }, [session, filterDate]);

  // 관리자 이메일 로그인
  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    const trimmedEmail = email.trim().toLowerCase();

    if (!ADMIN_EMAILS.includes(trimmedEmail)) {
      setAuthError('관리자 권한이 없는 이메일 계정입니다.');
      return;
    }

    setAuthLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (error) throw error;
    } catch (err) {
      setAuthError('로그인 실패: 이메일 또는 비밀번호를 확인해 주세요. (' + err.message + ')');
    } finally {
      setAuthLoading(false);
    }
  };

  // 관리자 로그아웃
  const handleAdminLogout = async () => {
    await supabase.auth.signOut();
  };

  // 날짜별 스케줄 목록 조회 (오늘 이후)
  const fetchDailyModes = async () => {
    const today = getTodayKST();
    const { data } = await supabase
      .from('daily_modes')
      .select('*')
      .gte('date', today)
      .order('date', { ascending: true });
    setDailyModes(data || []);
  };

  // 선택한 기간(시작일 ~ 종료일) 모드 변경 시도 (기존 활성 예약 충돌 검사 포함)
  const handleRequestRangeModeChange = async (startStr, endStr, nextMode) => {
    if (!startStr) {
      alert('시작일을 선택해 주세요.');
      return;
    }
    if (endStr && endStr < startStr) {
      alert('종료일은 시작일보다 빠를 수 없습니다.');
      return;
    }

    const targetDates = getDatesInRange(startStr, endStr);
    if (targetDates.length === 0) return;

    setModeSaving(true);
    try {
      const { data: existingRes, error } = await supabase
        .from('reservations')
        .select('id, date')
        .in('date', targetDates)
        .eq('status', 'active');

      if (error) {
        alert('예약 현황 조회 중 오류: ' + error.message);
        return;
      }

      if (existingRes && existingRes.length > 0) {
        setConflictModal({
          dates: targetDates,
          nextMode,
          conflictCount: existingRes.length,
        });
        return;
      }

      await applyRangeModeChange(targetDates, nextMode, false);
    } finally {
      setModeSaving(false);
    }
  };

  // 기간 모드 변경 최종 적용
  const applyRangeModeChange = async (targetDates, nextMode, cancelExisting) => {
    setModeSaving(true);
    try {
      if (cancelExisting) {
        const { error: cancelErr } = await supabase
          .from('reservations')
          .update({ status: 'cancelled' })
          .in('date', targetDates)
          .eq('status', 'active');
        if (cancelErr) throw cancelErr;
      }

      if (nextMode === 'study_room') {
        const { error: delErr } = await supabase
          .from('daily_modes')
          .delete()
          .in('date', targetDates);
        if (delErr) throw delErr;
      } else {
        const rows = targetDates.map((date) => ({
          date,
          mode: nextMode,
        }));
        const { error: upsertErr } = await supabase
          .from('daily_modes')
          .upsert(rows, { onConflict: 'date' });
        if (upsertErr) throw upsertErr;
      }

      setConflictModal(null);
      await fetchDailyModes();
      if (targetDates.includes(filterDate)) {
        await fetchReservationsByDate(filterDate);
      }

      const periodLabel =
        targetDates.length === 1
          ? targetDates[0]
          : `${targetDates[0]} ~ ${targetDates[targetDates.length - 1]} (${targetDates.length}일)`;

      alert(
        `${periodLabel} 운영 모드가 [${nextMode === 'reading_room' ? '열람실 모드' : '기본 스터디룸 모드'}]로 적용되었습니다.`
      );
    } catch (err) {
      alert('모드 변경 실패: ' + err.message);
    } finally {
      setModeSaving(false);
    }
  };

  // 전체 회원 신청/등급 목록 조회
  const fetchMemberProfiles = async () => {
    const { data } = await supabase
      .from('member_profiles')
      .select('*')
      .order('created_at', { ascending: false });
    setMemberProfiles(data || []);
  };

  // 회원 승인 및 등급 변경 ('associate' | 'regular' | 'rejected')
  const handleUpdateMemberStatus = async (studentId, nextStatus, memberName) => {
    const { error } = await supabase
      .from('member_profiles')
      .update({ status: nextStatus })
      .eq('student_id', studentId);

    if (error) {
      alert('처리 실패: ' + error.message);
      return;
    }

    // 기존 regular_members 테이블과도 동기화 유지
    if (nextStatus === 'regular') {
      await supabase
        .from('regular_members')
        .upsert([{ name: memberName, student_id: studentId }], {
          onConflict: 'student_id',
        });
    } else {
      await supabase
        .from('regular_members')
        .delete()
        .eq('student_id', studentId);
    }

    const labelMap = {
      associate: '승인 완료 (기본 준회원 등록)',
      regular: '정회원 승격 완료',
      rejected: '가입 반려 처리',
    };
    alert(`[${memberName} (${studentId})] 회원이 [${labelMap[nextStatus]}] 되었습니다.`);
    fetchMemberProfiles();
  };

  // 회원 신청 내역 완전 삭제
  const handleDeleteMemberProfile = async (studentId, memberName) => {
    if (!window.confirm(`[${memberName} (${studentId})] 회원 정보를 완전히 삭제하시겠습니까?`)) return;
    await supabase.from('regular_members').delete().eq('student_id', studentId);
    await supabase.from('member_profiles').delete().eq('student_id', studentId);
    fetchMemberProfiles();
  };

  // 이미 가입 신청된 학번을 정회원으로 빠른 승격
  const handleQuickPromoteByStudentId = async (e) => {
    e.preventDefault();
    const sid = quickStudentId.trim();
    if (!isValidStudentId(sid)) {
      alert('학번은 숫자 10자리로 정확히 입력해 주세요.');
      return;
    }

    const target = memberProfiles.find((m) => m.student_id === sid);
    if (!target) {
      alert('해당 학번으로 회원가입 신청된 내역이 없습니다. 먼저 학생이 회원가입 신청을 해야 합니다.');
      return;
    }

    await handleUpdateMemberStatus(target.student_id, 'regular', target.name);
    setQuickStudentId('');
  };

// 특정 날짜 전체 예약 상세 조회 (오늘 이전 날짜의 지난 예약은 DB에서 자동 삭제)
  const fetchReservationsByDate = async (dateStr) => {
    const today = getTodayKST();

    // 1. 오늘 날짜가 지난 과거 예약 데이터는 DB에서 자동 영구 삭제
    await supabase
      .from('reservations')
      .delete()
      .lt('date', today);

    // 2. 조회 선택한 날짜가 이미 지난 날이면 빈 목록 반환
    if (dateStr < today) {
      setAllReservations([]);
      return;
    }

    // 3. 오늘 및 이후 날짜의 예약만 조회
    const { data } = await supabase
      .from('reservations')
      .select('*')
      .eq('date', dateStr)
      .order('start_time', { ascending: true });
    setAllReservations(data || []);
  };
  // 관리자 직권 강제 취소
  const handleForceCancel = async (id) => {
    if (!window.confirm('관리자 권한으로 이 예약을 강제 취소하시겠습니까?')) return;
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('id', id);

    if (error) {
      alert('취소 실패: ' + error.message);
      return;
    }
    fetchReservationsByDate(filterDate);
  };

  // [화면 1] 관리자 로그인 화면
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2 text-slate-900">
              <ShieldCheck className="w-6 h-6 text-rose-600" />
              <h1 className="text-xl font-extrabold">학생회 관리자 로그인</h1>
            </div>
            <button
              onClick={onBackToStudent}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> 학생 화면
            </button>
          </div>

          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">관리자 이메일</label>
              <input
                type="email"
                required
                placeholder="imkorea.univ@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">비밀번호</label>
              <input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm"
              />
            </div>

            {authError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-sm transition"
            >
              {authLoading ? '인증 중...' : '관리자 대시보드 입장'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const readingRoomList = dailyModes.filter((d) => d.mode === 'reading_room');
  const pendingMembers = memberProfiles.filter((m) => m.status === 'pending');
  const approvedMembers = memberProfiles.filter(
    (m) => m.status === 'associate' || m.status === 'regular'
  );

  // [화면 2] 관리자 대시보드
  return (
    <div className="min-h-screen bg-slate-100 pb-16">
      <header className="bg-slate-900 text-white sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h1 className="font-extrabold text-base">학생회 공간 예약 관리자 콘솔</h1>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-300">{session.user.email}</span>
            <button
              onClick={onBackToStudent}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg"
            >
              학생 예약 페이지 보기
            </button>
            <button
              onClick={handleAdminLogout}
              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 rounded-lg flex items-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" /> 로그아웃
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 mt-6 space-y-6">
        {/* 탭 메뉴 */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTab('schedule')}
            className={`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition ${
              activeTab === 'schedule'
                ? 'bg-slate-900 text-white shadow'
                : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            <Calendar className="w-4 h-4" /> 1. 날짜별 모드 스케줄러
          </button>
          <button
            onClick={() => setActiveTab('members')}
            className={`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition ${
              activeTab === 'members'
                ? 'bg-slate-900 text-white shadow'
                : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            <Users className="w-4 h-4" /> 2. 가입 승인 및 등급 관리 (대기 {pendingMembers.length} · 승인 {approvedMembers.length})
          </button>
          <button
            onClick={() => setActiveTab('reservations')}
            className={`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition ${
              activeTab === 'reservations'
                ? 'bg-slate-900 text-white shadow'
                : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            <ListChecks className="w-4 h-4" /> 3. 전체 예약 현황 조회
          </button>
        </div>

        {/* [탭 1] 기간별 모드 스케줄러 */}
        {activeTab === 'schedule' && (
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">열람실 모드 기간 지정</h2>
              <p className="text-xs text-slate-500 mt-1">
                열람실 모드로 지정되지 않은 모든 날짜는 기본으로 <strong>스터디룸 모드(12:00~22:00)</strong>로
                운영됩니다. <strong>열람실 모드(24시간, 12좌석)</strong>로 운영할 시작일과 종료일을 선택하세요.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">시작일</label>
                <input
                  type="date"
                  min={getTodayKST()}
                  value={rangeStartDate}
                  onChange={(e) => {
                    const nextStart = e.target.value;
                    setRangeStartDate(nextStart);
                    if (rangeEndDate && rangeEndDate < nextStart) {
                      setRangeEndDate(nextStart);
                    }
                  }}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">종료일</label>
                <input
                  type="date"
                  min={rangeStartDate || getTodayKST()}
                  value={rangeEndDate}
                  onChange={(e) => setRangeEndDate(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                />
              </div>

              <button
                type="button"
                disabled={modeSaving}
                onClick={() =>
                  handleRequestRangeModeChange(rangeStartDate, rangeEndDate, 'reading_room')
                }
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl"
              >
                {modeSaving ? '적용 중...' : '선택 기간을 [열람실 모드]로 설정'}
              </button>

              <button
                type="button"
                disabled={modeSaving}
                onClick={() =>
                  handleRequestRangeModeChange(rangeStartDate, rangeEndDate, 'study_room')
                }
                className="px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl"
              >
                {modeSaving ? '적용 중...' : '선택 기간을 [스터디룸 모드]로 복귀'}
              </button>
            </div>

            <div>
              <h3 className="text-sm font-bold text-slate-800 mb-2">
                현재 [열람실 모드]로 지정된 날짜 목록
              </h3>
              {readingRoomList.length === 0 ? (
                <p className="text-xs text-slate-400 py-4">
                  열람실 모드로 지정된 날짜가 없습니다. (모든 날짜가 기본 스터디룸 모드로 운영 중)
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {readingRoomList.map((item) => (
                    <div
                      key={item.date}
                      className="p-3.5 rounded-xl border border-emerald-200 bg-emerald-50 flex items-center justify-between"
                    >
                      <div>
                        <div className="text-sm font-extrabold text-emerald-950">{item.date}</div>
                        <div className="text-xs text-emerald-700">열람실 모드 (24시간 · 12석)</div>
                      </div>
                      <button
                        type="button"
                        disabled={modeSaving}
                        onClick={() =>
                          handleRequestRangeModeChange(item.date, item.date, 'study_room')
                        }
                        className="px-2.5 py-1 bg-white border border-emerald-300 text-xs font-bold text-emerald-800 rounded-lg hover:bg-emerald-100"
                      >
                        해제
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* [탭 2] 가입 승인 및 회원 등급 관리 */}
        {activeTab === 'members' && (
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">가입 승인 및 회원 등급 관리</h2>
              <p className="text-xs text-slate-500 mt-1">
                신청자의 <strong>이름 · 학번 · 학과/학부</strong>를 확인하고 승인하면 기본{' '}
                <strong>준회원</strong>으로 등록되며, 필요 시 <strong>정회원</strong>으로 승격할 수 있습니다.
              </p>
            </div>

            {/* 1. 가입 승인 대기 목록 */}
            <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-3">
              <h3 className="text-sm font-extrabold text-amber-900">
                가입 승인 대기 ({pendingMembers.length}명)
              </h3>
              {pendingMembers.length === 0 ? (
                <p className="text-xs text-amber-700/80">현재 승인 대기 중인 회원가입 신청이 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {pendingMembers.map((m) => (
                    <div
                      key={m.student_id}
                      className="p-3.5 bg-white rounded-xl border border-amber-200 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-extrabold text-slate-900 text-sm">{m.name}</span>
                        <span className="font-mono text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
                          {m.student_id}
                        </span>
                        <span className="font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                          {m.department}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleUpdateMemberStatus(m.student_id, 'associate', m.name)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg"
                        >
                          승인 (준회원 등록)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateMemberStatus(m.student_id, 'rejected', m.name)}
                          className="px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-lg"
                        >
                          반려
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteMemberProfile(m.student_id, m.name)}
                          className="px-2 py-1.5 text-slate-400 hover:text-rose-600 text-xs"
                          title="신청 내역 삭제"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 학번 입력으로 정회원 빠른 승격 */}
            <form
              onSubmit={handleQuickPromoteByStudentId}
              className="flex flex-wrap items-end gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200"
            >
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  학번으로 바로 정회원 승격 (숫자 10자리)
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="2026170123"
                  value={quickStudentId}
                  onChange={(e) => setQuickStudentId(e.target.value.replace(/[^0-9]/g, ''))}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5"
              >
                <UserPlus className="w-4 h-4" /> 정회원으로 승격
              </button>
            </form>

            {/* 2. 승인된 전체 회원 목록 (준회원 / 정회원) */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500 bg-slate-50">
                    <th className="py-2.5 px-3">이름</th>
                    <th className="py-2.5 px-3">학번</th>
                    <th className="py-2.5 px-3">학과 / 학부</th>
                    <th className="py-2.5 px-3">현재 등급</th>
                    <th className="py-2.5 px-3 text-right">등급 관리</th>
                  </tr>
                </thead>
                <tbody>
                  {approvedMembers.map((m) => (
                    <tr key={m.student_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-bold text-slate-800">{m.name}</td>
                      <td className="py-2.5 px-3 text-slate-600 font-mono">{m.student_id}</td>
                      <td className="py-2.5 px-3 text-xs font-semibold text-slate-700">
                        {m.department}
                      </td>
                      <td className="py-2.5 px-3">
                        {m.status === 'regular' ? (
                          <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 text-xs font-bold rounded-full">
                            정회원
                          </span>
                        ) : (
                          <span className="px-2.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-bold rounded-full">
                            준회원
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right space-x-2">
                        {m.status === 'associate' ? (
                          <button
                            type="button"
                            onClick={() => handleUpdateMemberStatus(m.student_id, 'regular', m.name)}
                            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg"
                          >
                            정회원으로 승격
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleUpdateMemberStatus(m.student_id, 'associate', m.name)}
                            className="px-3 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold rounded-lg"
                          >
                            준회원으로 변경
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleUpdateMemberStatus(m.student_id, 'rejected', m.name)}
                          className="text-rose-500 hover:text-rose-700 p-1 align-middle"
                          title="승인 취소(반려)"
                        >
                          <Trash2 className="w-4 h-4 inline" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {approvedMembers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-xs text-slate-400">
                        승인된 회원이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* [탭 3] 전체 예약 현황 상세 조회 */}
        {activeTab === 'reservations' && (
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">날짜별 예약 현황 및 상세 내역</h2>
                <p className="text-xs text-slate-500">
                  관리자 화면에서는 예약자의 실명, 학번, 동반자 학번, 인원수, 사용 목적을 모두 확인할 수 있습니다.
                </p>
              </div>
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className="px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3">구분/좌석</th>
                    <th className="py-2.5 px-3">이용 시간</th>
                    <th className="py-2.5 px-3">예약자 (학번)</th>
                    <th className="py-2.5 px-3">동반자 / 인원 / 목적</th>
                    <th className="py-2.5 px-3">상태</th>
                    <th className="py-2.5 px-3 text-right">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {allReservations.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 px-3 font-bold">
                        {r.mode === 'reading_room' ? `열람실 ${r.seat_id}` : '스터디룸 전체'}
                      </td>
                      <td className="py-3 px-3 font-semibold text-slate-800">
                        {r.start_time} ~ {r.end_time}
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-bold text-slate-900">{r.student_name}</div>
                        <div className="text-slate-500 font-mono">{r.student_id}</div>
                      </td>
                      <td className="py-3 px-3 text-slate-600">
                        {r.mode === 'study_room' ? (
                          <div>
                            <div>총 {r.total_headcount}명 · 목적: {r.purpose}</div>
                            <div className="text-[11px] text-slate-400">
                              동반 학번: {(r.companion_ids || []).join(', ')}
                            </div>
                          </div>
                        ) : (
                          <span>개인 열람실 이용</span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded-full font-bold ${
                            r.status === 'active'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {r.status === 'active' ? '예약중' : '취소/종료'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        {r.status === 'active' && (
                          <button
                            onClick={() => handleForceCancel(r.id)}
                            className="px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white rounded-lg font-bold"
                          >
                            강제 취소
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {allReservations.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        해당 날짜에 등록된 예약 내역이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* 충돌 경고 모달 */}
      {conflictModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center gap-2 text-amber-600 mb-2">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="text-base font-extrabold">기존 예약 충돌 경고</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed mb-4">
              선택하신 기간(
              <strong>
                {conflictModal.dates[0]}
                {conflictModal.dates.length > 1
                  ? ` ~ ${conflictModal.dates[conflictModal.dates.length - 1]}`
                  : ''}
              </strong>
              )에 이미 <strong className="text-rose-600">{conflictModal.conflictCount}건의 활성 예약</strong>이
              존재합니다. 운영 모드를 변경하면 기존 예약과 충돌이 발생합니다. 기존 예약을 일괄 취소하고 모드를
              변경하시겠습니까?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConflictModal(null)}
                className="px-4 py-2 text-xs font-bold bg-slate-100 text-slate-700 rounded-xl"
              >
                변경 취소
              </button>
              <button
                onClick={() =>
                  applyRangeModeChange(conflictModal.dates, conflictModal.nextMode, true)
                }
                className="px-4 py-2 text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white rounded-xl"
              >
                기존 예약 일괄 취소 후 모드 변경
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}