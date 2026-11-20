import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import {
  getNext8Days,
  isValidStudentId,
  isValidPin,
  generateTimeSlots,
  isSlotPast,
  isReservationInProgress,
} from './utils';
import {
  Calendar,
  Clock,
  UserCheck,
  Users,
  Lock,
  LogOut,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  ArrowUp,
} from 'lucide-react';

const READING_ROOM_COOLDOWN_MS = 10 * 60 * 1000;

// 실제 열람실 도면 기준 테이블 & 좌석 배치
const ROOM_TABLES = [
  {
    name: 'A 테이블',
    topSeats: ['A-1', 'A-2'],
    bottomSeats: ['A-3', 'A-4'],
  },
  {
    name: 'B 테이블',
    topSeats: ['B-5', 'B-6'],
    bottomSeats: ['B-7', 'B-8'],
  },
  {
    name: 'C 테이블',
    topSeats: ['C-9', 'C-10'],
    bottomSeats: ['C-11', 'C-12'],
  },
];

// "HH:MM:SS" 또는 "HH:MM" -> "HH:MM"으로 통일
function formatHHMM(timeStr) {
  if (!timeStr) return '00:00';
  return String(timeStr).slice(0, 5);
}

// "HH:MM" -> 자정(00:00) 기준 분(minutes) 변환 ("24:00" 지원)
function timeToMinutes(hhmm) {
  const clean = formatHHMM(hhmm);
  if (clean === '24:00') return 24 * 60;
  const [h, m] = clean.split(':').map(Number);
  return h * 60 + m;
}

// 현재 KST 시각 기준 "YYYY-MM-DD" 및 총 분(0~1440) 반환
function getNowKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = kst.getUTCHours();
  const mi = kst.getUTCMinutes();
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    totalMinutes: hh * 60 + mi,
    hh,
    mi,
  };
}

// 해당 예약의 이용 시간이 이미 종료되었는지 판별
function isReservationExpired(dateStr, endHHMM) {
  const nowKST = getNowKST();
  if (dateStr < nowKST.dateStr) return true;
  if (dateStr > nowKST.dateStr) return false;
  return timeToMinutes(endHHMM) <= nowKST.totalMinutes;
}

// 이용 시간 옵션 생성 (30분 단위, 최대 maxHours 시간)
function buildDurationOptions(maxHours = 4) {
  const options = [];
  const maxSlots = maxHours * 2;
  for (let slots = 1; slots <= maxSlots; slots++) {
    const minutes = slots * 30;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    let label = '';
    if (h > 0 && m > 0) label = `${h}시간 ${m}분`;
    else if (h > 0) label = `${h}시간`;
    else label = `${m}분`;
    options.push({ slots, minutes, label });
  }
  return options;
}

// "HH:MM" + slots(30분 단위) -> "HH:MM" 계산
function addSlotsToTime(startHHMM, slots) {
  const totalMinutes = timeToMinutes(startHHMM) + slots * 30;
  if (totalMinutes === 24 * 60) return '24:00';
  const endH = Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export default function StudentView({ onSwitchToAdmin }) {
  // 로그인 / 회원가입 탭 상태
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'signup'
  const [inputName, setInputName] = useState('');
  const [inputStudentId, setInputStudentId] = useState('');
  const [inputDepartment, setInputDepartment] = useState('');

  const [studentInfo, setStudentInfo] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const days = useMemo(() => getNext8Days(), []);
  const [selectedDate, setSelectedDate] = useState(days[0].dateStr);
  const [currentMode, setCurrentMode] = useState('study_room'); // 기본값은 스터디룸
  const [selectedSeat, setSelectedSeat] = useState('A-1');
  const [publicReservations, setPublicReservations] = useState([]);
  const [myReservations, setMyReservations] = useState([]);
  const [myRecentCancelled, setMyRecentCancelled] = useState([]);
  const [loadingData, setLoadingData] = useState(false);

  const [startTime, setStartTime] = useState('12:00');
  const [durationSlots, setDurationSlots] = useState(2);

  const [showBookingModal, setShowBookingModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [companionInput, setCompanionInput] = useState('');
  const [companionList, setCompanionList] = useState([]);
  const [totalHeadcount, setTotalHeadcount] = useState(2);
  const [purpose, setPurpose] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [bookingSubmitting, setBookingSubmitting] = useState(false);

  const [actionModal, setActionModal] = useState(null);
  const [actionPin, setActionPin] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // 로그인 처리 (이름 + 학번)
  const handleStudentLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginMessage('');

    const trimmedName = inputName.trim();
    const trimmedId = inputStudentId.trim();

    if (!trimmedName) {
      setLoginError('이름을 입력해 주세요.');
      return;
    }
    if (!isValidStudentId(trimmedId)) {
      setLoginError('학번은 숫자 10자리로 정확히 입력해 주세요. (예: 2026170123)');
      return;
    }

    setLoginLoading(true);
    try {
      const { data: profile, error } = await supabase
        .from('member_profiles')
        .select('*')
        .eq('student_id', trimmedId)
        .maybeSingle();

      if (error) throw error;

      if (!profile) {
        setLoginError('가입 내역이 없는 학번입니다. 먼저 [회원가입 신청] 탭에서 신청해 주세요.');
        return;
      }

      if (profile.name.trim() !== trimmedName) {
        setLoginError('입력하신 이름과 해당 학번의 등록된 이름이 일치하지 않습니다.');
        return;
      }

      setStudentInfo({
        name: profile.name,
        studentId: profile.student_id,
        department: profile.department,
        status: profile.status,
        isRegular: profile.status === 'regular',
      });
    } catch (err) {
      setLoginError('접속 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  // 회원가입 신청 처리
  const handleStudentSignup = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginMessage('');

    const trimmedName = inputName.trim();
    const trimmedId = inputStudentId.trim();
    const trimmedDept = inputDepartment.trim();

    if (!trimmedName) {
      setLoginError('이름을 입력해 주세요.');
      return;
    }
    if (!isValidStudentId(trimmedId)) {
      setLoginError('학번은 숫자 10자리로 정확히 입력해 주세요. (예: 2026170123)');
      return;
    }
    if (!trimmedDept) {
      setLoginError('학과 또는 학부를 입력해 주세요.');
      return;
    }

    setLoginLoading(true);
    try {
      const { data: existing } = await supabase
        .from('member_profiles')
        .select('student_id, status')
        .eq('student_id', trimmedId)
        .maybeSingle();

      if (existing) {
        if (existing.status === 'pending') {
          setLoginError('이미 회원가입 신청이 접수되어 관리자 승인 대기 중인 학번입니다.');
        } else if (existing.status === 'associate' || existing.status === 'regular') {
          setLoginError('이미 승인 완료된 학번입니다. [로그인] 탭에서 바로 입장해 주세요.');
        } else {
          setLoginError('이미 신청 이력이 있는 학번입니다. 관리자에게 문의해 주세요.');
        }
        return;
      }

      const { error: insertErr } = await supabase.from('member_profiles').insert([
        {
          student_id: trimmedId,
          name: trimmedName,
          department: trimmedDept,
          status: 'pending',
        },
      ]);

      if (insertErr) throw insertErr;

      setInputDepartment('');
      setAuthMode('login');
      setLoginMessage(
        `[${trimmedName} / ${trimmedDept}] 회원가입 신청이 완료되었습니다! 편입연 관리자 확인 및 승인 후 로그인하실 수 있습니다.`
      );
    } catch (err) {
      setLoginError('회원가입 신청 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setStudentInfo(null);
    setLoginError('');
    setLoginMessage('');
  };

  const fetchScheduleAndReservations = async () => {
    if (!studentInfo || (studentInfo.status !== 'associate' && studentInfo.status !== 'regular')) {
      return;
    }
    setLoadingData(true);

    try {
      const { data: modeData, error: modeErr } = await supabase
        .from('daily_modes')
        .select('mode')
        .eq('date', selectedDate)
        .maybeSingle();

      if (modeErr) throw modeErr;
      const resolvedMode = modeData?.mode === 'reading_room' ? 'reading_room' : 'study_room';
      setCurrentMode(resolvedMode);

      const defaultStart = resolvedMode === 'reading_room' ? '09:00' : '12:00';
      setStartTime(defaultStart);
      setDurationSlots(2);

      if (resolvedMode === 'study_room') {
        setSelectedSeat('ROOM-ALL');
      } else if (selectedSeat === 'ROOM-ALL') {
        setSelectedSeat('A-1');
      }

      // 1. 전체 활성 예약 조회 후 종료된 예약은 제외
      const { data: pubData, error: pubErr } = await supabase
        .from('public_reservations')
        .select('*')
        .eq('date', selectedDate)
        .eq('status', 'active');

      const rawPub =
        !pubErr && pubData
          ? pubData
          : (
              await supabase
                .from('reservations')
                .select('id, date, mode, seat_id, start_time, end_time, status')
                .eq('date', selectedDate)
                .eq('status', 'active')
            ).data || [];

      const activeNotExpiredPub = rawPub.filter(
        (r) => !isReservationExpired(r.date || selectedDate, formatHHMM(r.end_time))
      );
      setPublicReservations(activeNotExpiredPub);

      // 2. 내 활성 예약 중 아직 종료되지 않은 예약만 노출
      const nowKST = getNowKST();
      const { data: myData } = await supabase
        .from('reservations')
        .select('id, date, mode, seat_id, start_time, end_time, total_headcount, purpose, status')
        .eq('student_id', studentInfo.studentId)
        .eq('status', 'active')
        .gte('date', nowKST.dateStr)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true });

      const activeNotExpiredMine = (myData || []).filter(
        (r) => !isReservationExpired(r.date, formatHHMM(r.end_time))
      );
      setMyReservations(activeNotExpiredMine);

      // 3. 취소한 본인(student_id)이 최근 10분 이내 취소한 열람실 좌석 내역 조회
      const cooldownCutoffISO = new Date(Date.now() - READING_ROOM_COOLDOWN_MS).toISOString();
      const { data: myCancelledData } = await supabase
        .from('reservations')
        .select('id, date, mode, seat_id, start_time, end_time, cancelled_at')
        .eq('student_id', studentInfo.studentId)
        .eq('date', selectedDate)
        .eq('mode', 'reading_room')
        .eq('status', 'cancelled')
        .gt('cancelled_at', cooldownCutoffISO);

      setMyRecentCancelled(myCancelledData || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    fetchScheduleAndReservations();
  }, [studentInfo, selectedDate]);

  // 시간이 지나면 만료된 예약을 화면에서 자동 제거 (1분 간격 체크)
  useEffect(() => {
    if (!studentInfo) return;
    const timer = setInterval(() => {
      setMyReservations((prev) =>
        prev.filter((r) => !isReservationExpired(r.date, formatHHMM(r.end_time)))
      );
      setPublicReservations((prev) =>
        prev.filter((r) => !isReservationExpired(r.date || selectedDate, formatHHMM(r.end_time)))
      );
    }, 60000);
    return () => clearInterval(timer);
  }, [studentInfo, selectedDate]);

  const timeSlots = useMemo(() => generateTimeSlots(currentMode), [currentMode]);
  const operatingStartTime = currentMode === 'reading_room' ? '00:00' : '12:00';
  const operatingEndTime = currentMode === 'reading_room' ? '24:00' : '22:00';

  const currentSeatReservations = useMemo(() => {
    return publicReservations.filter(
      (r) =>
        r.seat_id === selectedSeat &&
        r.status === 'active' &&
        !isReservationExpired(r.date || selectedDate, formatHHMM(r.end_time))
    );
  }, [publicReservations, selectedSeat, selectedDate]);

  const availableStartSlots = useMemo(() => {
    return timeSlots.filter((slot) => {
      const past = isSlotPast(selectedDate, slot.end);
      const reserved = currentSeatReservations.some(
        (r) =>
          formatHHMM(r.start_time) < slot.end &&
          formatHHMM(r.end_time) > slot.start
      );
      return !past && !reserved;
    });
  }, [timeSlots, selectedDate, currentSeatReservations]);

  useEffect(() => {
    if (availableStartSlots.length > 0) {
      const stillValid = availableStartSlots.some((s) => s.start === startTime);
      if (!stillValid) {
        setStartTime(availableStartSlots[0].start);
      }
    }
  }, [availableStartSlots, startTime]);

  const durationOptions = useMemo(() => {
    const maxHours =
      currentMode === 'reading_room' && studentInfo?.isRegular ? 12 : 4;
    return buildDurationOptions(maxHours);
  }, [currentMode, studentInfo]);

  const computedEndTime = useMemo(
    () => addSlotsToTime(startTime, durationSlots),
    [startTime, durationSlots]
  );

  // 취소한 본인에게만 열람실 동일 좌석 10분 쿨다운 적용
  const myCooldownConflict = useMemo(() => {
    if (currentMode !== 'reading_room') return null;
    const nowMs = Date.now();
    return (
      myRecentCancelled.find((c) => {
        if (c.seat_id !== selectedSeat || !c.cancelled_at) return false;
        const elapsed = nowMs - new Date(c.cancelled_at).getTime();
        if (elapsed >= READING_ROOM_COOLDOWN_MS) return false;
        return (
          formatHHMM(c.start_time) < computedEndTime &&
          formatHHMM(c.end_time) > startTime
        );
      }) || null
    );
  }, [currentMode, myRecentCancelled, selectedSeat, startTime, computedEndTime]);

  const rangeValidation = useMemo(() => {
    if (!startTime || availableStartSlots.length === 0) {
      return { valid: false, reason: '예약 가능한 시작 시간이 없습니다.' };
    }
    if (computedEndTime > operatingEndTime) {
      return {
        valid: false,
        reason: `운영 종료 시각(${operatingEndTime})을 초과했습니다. 이용 시간을 줄여주세요.`,
      };
    }
    const overlaps = currentSeatReservations.some(
      (r) =>
        formatHHMM(r.start_time) < computedEndTime &&
        formatHHMM(r.end_time) > startTime
    );
    if (overlaps) {
      return {
        valid: false,
        reason: '선택한 시간 범위 중간에 이미 예약된 시간이 포함되어 있습니다.',
      };
    }
    if (myCooldownConflict) {
      const remainMin = Math.max(
        1,
        Math.ceil(
          (READING_ROOM_COOLDOWN_MS -
            (Date.now() - new Date(myCooldownConflict.cancelled_at).getTime())) /
            60000
        )
      );
      return {
        valid: false,
        reason: `본인이 취소한 [${selectedSeat}] 좌석은 취소 후 10분간 동일 좌석 재예약이 제한됩니다. (약 ${remainMin}분 후 가능)`,
      };
    }
    return { valid: true, reason: '' };
  }, [
    startTime,
    computedEndTime,
    operatingEndTime,
    currentSeatReservations,
    availableStartSlots,
    myCooldownConflict,
    selectedSeat,
  ]);

  const buildBlocksForRange = (rangeStartMin, rangeEndMin) => {
    const span = rangeEndMin - rangeStartMin;
    return currentSeatReservations
      .map((r) => {
        const sMin = Math.max(rangeStartMin, timeToMinutes(r.start_time));
        const eMin = Math.min(rangeEndMin, timeToMinutes(r.end_time));
        if (eMin <= sMin) return null;
        return {
          id: `${r.id}-${rangeStartMin}`,
          label: `${formatHHMM(r.start_time)}~${formatHHMM(r.end_time)}`,
          leftPct: ((sMin - rangeStartMin) / span) * 100,
          widthPct: ((eMin - sMin) / span) * 100,
        };
      })
      .filter(Boolean);
  };

  const amBlocks = useMemo(() => buildBlocksForRange(0, 12 * 60), [currentSeatReservations]);
  const pmBlocks = useMemo(() => buildBlocksForRange(12 * 60, 24 * 60), [currentSeatReservations]);
  const studyBlocks = useMemo(() => buildBlocksForRange(12 * 60, 22 * 60), [currentSeatReservations]);

  const handleAddCompanionId = () => {
    setBookingError('');
    const cleanId = companionInput.trim();

    if (!isValidStudentId(cleanId)) {
      setBookingError('동반자 학번은 숫자 10자리로 정확히 입력해 주세요.');
      return;
    }
    if (cleanId === studentInfo.studentId) {
      setBookingError('동반자 학번에 본인 학번은 추가할 수 없습니다.');
      return;
    }
    if (companionList.includes(cleanId)) {
      setBookingError('이미 추가된 동반자 학번입니다.');
      return;
    }

    const nextList = [...companionList, cleanId];
    setCompanionList(nextList);
    setCompanionInput('');
    setTotalHeadcount(nextList.length + 1);
  };

  const handleRemoveCompanionId = (targetId) => {
    setBookingError('');
    const nextList = companionList.filter((id) => id !== targetId);
    setCompanionList(nextList);
    setTotalHeadcount(Math.max(2, nextList.length + 1));
  };

  const handleOpenBookingModal = () => {
    if (!rangeValidation.valid) {
      alert(rangeValidation.reason);
      return;
    }

    if (currentMode === 'reading_room' && !studentInfo.isRegular) {
      const todayMySlots = myReservations
        .filter((r) => r.date === selectedDate && r.mode === 'reading_room')
        .reduce((acc, r) => {
          const diffMin = timeToMinutes(r.end_time) - timeToMinutes(r.start_time);
          return acc + diffMin / 30;
        }, 0);

      if (todayMySlots + durationSlots > 8) {
        alert(
          `준회원은 열람실(시험기간)을 하루 최대 4시간(8칸)까지만 예약할 수 있습니다.\n(현재 해당 날짜 기예약: ${todayMySlots * 0.5}시간)`
        );
        return;
      }
    }

    if (currentMode === 'study_room' && durationSlots > 8) {
      alert('스터디룸은 1회 및 하루 최대 4시간까지만 예약할 수 있습니다.');
      return;
    }

    const hasOverlap = myReservations.some(
      (r) =>
        r.date === selectedDate &&
        formatHHMM(r.start_time) < computedEndTime &&
        formatHHMM(r.end_time) > startTime
    );
    if (hasOverlap) {
      alert('동일한 시간대에 이미 다른 좌석(또는 스터디룸) 예약 내역이 있어 중복 예약할 수 없습니다.');
      return;
    }

    setBookingError('');
    setPinInput('');
    setCompanionInput('');
    setCompanionList([]);
    setTotalHeadcount(2);
    setPurpose('');
    setShowBookingModal(true);
  };

  const handleConfirmBooking = async (e) => {
    e.preventDefault();
    setBookingError('');
    if (!rangeValidation.valid) return;

    if (!isValidPin(pinInput)) {
      setBookingError('취소·퇴실 확인용 일회성 비밀번호는 숫자 4자리로 입력해 주세요.');
      return;
    }

    let finalCompanions = [];
    if (currentMode === 'study_room') {
      finalCompanions = [...companionList];

      if (finalCompanions.length < 1) {
        setBookingError('동반자 학번을 최소 1명 이상 추가해 주세요.');
        return;
      }

      for (const cid of finalCompanions) {
        if (!isValidStudentId(cid)) {
          setBookingError(`동반자 학번(${cid})이 올바르지 않습니다.`);
          return;
        }
        if (cid === studentInfo.studentId) {
          setBookingError('동반자 학번에 본인 학번을 중복 입력할 수 없습니다.');
          return;
        }
      }

      const expectedHeadcount = finalCompanions.length + 1;
      const numericHeadcount = Number(totalHeadcount);

      if (numericHeadcount < 2) {
        setBookingError('총 인원은 최소 2명 이상이어야 합니다.');
        return;
      }

      if (numericHeadcount !== expectedHeadcount) {
        setBookingError(
          `본인(1명)과 동반자(${finalCompanions.length}명)를 포함한 인원(${expectedHeadcount}명)과 총 인원(${numericHeadcount}명)이 일치해야 합니다.`
        );
        return;
      }

      if (!purpose.trim()) {
        setBookingError('스터디룸 사용 목적을 입력해 주세요.');
        return;
      }

      const allIds = [studentInfo.studentId, ...finalCompanions];
      const { data: regList, error: regErr } = await supabase
        .from('member_profiles')
        .select('student_id')
        .in('student_id', allIds)
        .eq('status', 'regular');

      if (regErr) {
        setBookingError('정회원 자격 확인 중 오류가 발생했습니다.');
        return;
      }

      if (!regList || regList.length === 0) {
        setBookingError(
          '스터디룸 예약 조건 미달: 대표자와 동반자 중 최소 1명은 반드시 정회원이어야 합니다.'
        );
        return;
      }

      const todayStudySlots = myReservations
        .filter((r) => r.date === selectedDate && r.mode === 'study_room')
        .reduce((acc, r) => {
          const diffMin = timeToMinutes(r.end_time) - timeToMinutes(r.start_time);
          return acc + diffMin / 30;
        }, 0);

      if (todayStudySlots + durationSlots > 8) {
        setBookingError('스터디룸은 하루 최대 4시간까지만 이용할 수 있습니다.');
        return;
      }
    }

    setBookingSubmitting(true);
    try {
      const { data: conflictCheck } = await supabase
        .from('reservations')
        .select('id')
        .eq('date', selectedDate)
        .eq('seat_id', selectedSeat)
        .eq('status', 'active')
        .lt('start_time', computedEndTime)
        .gt('end_time', startTime);

      if (conflictCheck && conflictCheck.length > 0) {
        setBookingError('방금 다른 사용자가 먼저 해당 시간을 예약했습니다. 새로고침 후 다시 선택해 주세요.');
        setBookingSubmitting(false);
        return;
      }

      if (currentMode === 'reading_room') {
        const cooldownCutoffISO = new Date(Date.now() - READING_ROOM_COOLDOWN_MS).toISOString();
        const { data: cooldownCheck } = await supabase
          .from('reservations')
          .select('id')
          .eq('student_id', studentInfo.studentId)
          .eq('date', selectedDate)
          .eq('mode', 'reading_room')
          .eq('seat_id', selectedSeat)
          .eq('status', 'cancelled')
          .gt('cancelled_at', cooldownCutoffISO)
          .lt('start_time', computedEndTime)
          .gt('end_time', startTime);

        if (cooldownCheck && cooldownCheck.length > 0) {
          setBookingError(
            `본인이 취소한 [${selectedSeat}] 좌석은 취소 후 10분간 동일 좌석 재예약이 제한됩니다.`
          );
          setBookingSubmitting(false);
          return;
        }
      }

      const payload = {
        date: selectedDate,
        mode: currentMode,
        seat_id: selectedSeat,
        start_time: startTime,
        end_time: computedEndTime,
        student_id: studentInfo.studentId,
        student_name: studentInfo.name,
        companion_ids: currentMode === 'study_room' ? finalCompanions : [],
        total_headcount: currentMode === 'study_room' ? Number(totalHeadcount) : 1,
        purpose: currentMode === 'study_room' ? purpose.trim() : '개인 열람실 이용',
        temp_password: pinInput.trim(),
        status: 'active',
      };

      const { error: insertErr } = await supabase.from('reservations').insert([payload]);
      if (insertErr) throw insertErr;

      alert('예약이 완료되었습니다! 취소 또는 퇴실 시 방금 입력한 4자리 비밀번호가 필요합니다.');
      setShowBookingModal(false);
      fetchScheduleAndReservations();
    } catch (err) {
      setBookingError('예약 저장 실패: ' + err.message);
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handleExecuteAction = async (e) => {
    e.preventDefault();
    setActionError('');
    if (!isValidPin(actionPin)) {
      setActionError('예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요.');
      return;
    }

    const target = actionModal.reservation;
    setActionSubmitting(true);

    try {
      if (actionModal.type === 'cancel') {
        const cancelledAtISO = new Date().toISOString();
        const { data: verifyRow } = await supabase
          .from('reservations')
          .select('id, temp_password, status')
          .eq('id', target.id)
          .single();

        if (!verifyRow || verifyRow.status !== 'active') {
          setActionError('이미 취소되었거나 존재하지 않는 예약입니다.');
          setActionSubmitting(false);
          return;
        }

        if (verifyRow.temp_password !== actionPin.trim()) {
          setActionError('비밀번호가 일치하지 않습니다.');
          setActionSubmitting(false);
          return;
        }

        const { error: updErr } = await supabase
          .from('reservations')
          .update({ status: 'cancelled', cancelled_at: cancelledAtISO })
          .eq('id', target.id);
        if (updErr) throw updErr;

        alert(
          target.mode === 'reading_room'
            ? `예약이 취소되었습니다. 본인은 [${target.seat_id}] 좌석을 10분간 재예약할 수 없습니다.`
            : '예약이 정상적으로 취소되었습니다.'
        );
      } else if (actionModal.type === 'early_exit') {
        const nowKST = getNowKST();
        const curH = nowKST.hh;
        const curM = nowKST.mi;

        const nextEndH = curM < 30 ? curH : curH + 1;
        const nextEndM = curM < 30 ? 30 : 0;
        const newEndTime = `${String(nextEndH).padStart(2, '0')}:${String(nextEndM).padStart(2, '0')}`;

        const { data: rpcExit, error: rpcExitErr } = await supabase.rpc('early_checkout_with_pin', {
          p_reservation_id: target.id,
          p_pin: actionPin.trim(),
          p_new_end_time: newEndTime,
        });

        if (rpcExitErr) {
          const { data: verifyRow } = await supabase
            .from('reservations')
            .select('id, temp_password, start_time, end_time')
            .eq('id', target.id)
            .single();

          if (!verifyRow || verifyRow.temp_password !== actionPin.trim()) {
            setActionError('비밀번호가 일치하지 않습니다.');
            setActionSubmitting(false);
            return;
          }

          if (newEndTime < formatHHMM(verifyRow.end_time)) {
            await supabase
              .from('reservations')
              .update({ end_time: newEndTime })
              .eq('id', target.id);
          } else {
            await supabase
              .from('reservations')
              .update({ status: 'completed' })
              .eq('id', target.id);
          }
        } else if (rpcExit === false) {
          setActionError('비밀번호가 일치하지 않습니다.');
          setActionSubmitting(false);
          return;
        }

        alert(`퇴실 처리가 완료되었습니다. (${newEndTime} 이후 잔여 시간이 빈자리로 반환되었습니다.)`);
      }

      setActionModal(null);
      setActionPin('');
      fetchScheduleAndReservations();
    } catch (err) {
      setActionError('처리 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setActionSubmitting(false);
    }
  };

  // 타임라인 구간 렌더링
  const renderTimelineStrip = ({ titleBadge, startHour, cols, blocks }) => {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] font-bold text-slate-600">
          <span>{titleBadge}</span>
        </div>
        <div className="relative h-4 text-[10px] font-bold text-slate-600 select-none">
          {Array.from({ length: cols + 1 }, (_, idx) => {
            const hourVal = startHour + idx;
            const pct = (idx / cols) * 100;
            const isFirst = idx === 0;
            const isLast = idx === cols;
            const labelText =
              currentMode === 'study_room' && (isFirst || isLast)
                ? `${hourVal}시`
                : String(hourVal).padStart(2, '0');
            const posClass = isFirst
              ? 'left-0 translate-x-0'
              : isLast
              ? 'right-0 translate-x-0'
              : '-translate-x-1/2';

            return (
              <span
                key={hourVal}
                style={isLast ? undefined : { left: `${pct}%` }}
                className={`absolute top-0 ${posClass} tabular-nums whitespace-nowrap`}
              >
                {labelText}
              </span>
            );
          })}
        </div>

        <div
          className="relative grid rounded-lg overflow-hidden border border-emerald-600 bg-emerald-500"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: cols }, (_, idx) => (
            <div
              key={idx}
              className="h-8 border-r last:border-r-0 border-emerald-700/35"
            />
          ))}

          {blocks.map((blk) => (
            <button
              key={blk.id}
              type="button"
              onClick={() =>
                alert(`[예약됨] ${blk.label} 시간대는 이미 예약되어 있습니다.`)
              }
              style={{
                left: `${blk.leftPct}%`,
                width: `${Math.max(blk.widthPct, 2)}%`,
              }}
              className="absolute top-0 bottom-0 bg-gray-300/95 hover:bg-gray-400 text-gray-800 border-x border-gray-500/50 flex items-center justify-center text-[10px] font-extrabold truncate px-0.5 cursor-pointer transition z-10"
              title={`${blk.label} 예약됨`}
            >
              {blk.widthPct >= 16 ? blk.label : '예약됨'}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // 도면 내 개별 좌석 버튼
  const renderSeatButton = (seatId, position) => {
    const isSelected = selectedSeat === seatId;
    return (
      <button
        key={seatId}
        type="button"
        onClick={() => setSelectedSeat(seatId)}
        className="group flex flex-col items-center focus:outline-none active:scale-95 transition-transform"
        aria-label={`${seatId} 좌석 선택`}
      >
        {position === 'top' && (
          <span
            className={`w-10 h-1.5 rounded-full mb-1 transition-colors ${
              isSelected ? 'bg-slate-900' : 'bg-emerald-700 group-hover:bg-emerald-800'
            }`}
          />
        )}
        <span
          className={`w-13 sm:w-14 h-10 sm:h-11 rounded-xl border-2 flex items-center justify-center text-xs font-extrabold transition-all ${
            isSelected
              ? 'bg-slate-900 text-white border-slate-900 shadow-md ring-2 ring-emerald-400'
              : 'bg-emerald-50 text-slate-800 border-emerald-700 hover:bg-emerald-100'
          }`}
        >
          {seatId}
        </span>
        {position === 'bottom' && (
          <span
            className={`w-10 h-1.5 rounded-full mt-1 transition-colors ${
              isSelected ? 'bg-slate-900' : 'bg-emerald-700 group-hover:bg-emerald-800'
            }`}
          />
        )}
      </button>
    );
  };

  // [화면 1] 로그인 / 회원가입 신청 화면
  if (!studentInfo) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-6">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-lg border border-slate-200 p-6 sm:p-8">
          <div className="text-center mb-5">
            <span className="inline-block px-3 py-1 bg-rose-50 text-rose-700 text-xs font-bold rounded-full mb-2">
              편입연 공간 통합 예약 시스템
            </span>
            <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900">
              열람실(시험기간) · 스터디룸 예약
            </h1>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              {authMode === 'login'
                ? '승인된 회원은 이름과 10자리 학번으로 바로 입장할 수 있습니다.'
                : '이름·학번·학과/학부를 입력해 가입 신청하면 관리자 확인 후 준회원으로 등록됩니다.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-2xl mb-5">
            <button
              type="button"
              onClick={() => {
                setAuthMode('login');
                setLoginError('');
              }}
              className={`min-h-[42px] text-xs font-bold rounded-xl transition ${
                authMode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
              }`}
            >
              로그인
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('signup');
                setLoginError('');
                setLoginMessage('');
              }}
              className={`min-h-[42px] text-xs font-bold rounded-xl transition ${
                authMode === 'signup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
              }`}
            >
              회원가입 신청
            </button>
          </div>

          <form
            onSubmit={authMode === 'login' ? handleStudentLogin : handleStudentSignup}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">이름</label>
              <input
                type="text"
                required
                autoComplete="name"
                placeholder="박신우"
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                학번 (숫자 10자리)
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                required
                maxLength={10}
                placeholder="2026170123"
                value={inputStudentId}
                onChange={(e) => setInputStudentId(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none tracking-wider"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                입력된 자릿수: {inputStudentId.length} / 10자리
              </p>
            </div>

            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">학과 / 학부</label>
                <input
                  type="text"
                  required
                  placeholder="예: 경영학과, 컴퓨터학과, 자유전공학부"
                  value={inputDepartment}
                  onChange={(e) => setInputDepartment(e.target.value)}
                  className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>
            )}

            {loginMessage && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 leading-relaxed">
                {loginMessage}
              </div>
            )}

            {loginError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full min-h-[48px] py-3 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl text-sm transition shadow-sm"
            >
              {loginLoading
                ? '확인 중...'
                : authMode === 'login'
                ? '입장하기'
                : '회원가입 신청하기'}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <button
              type="button"
              onClick={onSwitchToAdmin}
              className="text-xs text-slate-400 hover:text-slate-600 underline py-2"
            >
              편입연 관리자 페이지로 이동
            </button>
          </div>
        </div>
      </div>
    );
  }

  // [화면 1-2] 승인 대기 / 반려 안내 화면
  if (studentInfo.status !== 'associate' && studentInfo.status !== 'regular') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-lg border border-slate-200 p-7 text-center space-y-4">
          <div className="inline-flex px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">
            {studentInfo.status === 'pending' ? '가입 승인 대기 중' : '가입 승인 반려'}
          </div>
          <h2 className="text-xl font-extrabold text-slate-900">
            {studentInfo.name} ({studentInfo.studentId})
          </h2>
          <p className="text-xs font-semibold text-slate-500">
            신청 학과/학부: {studentInfo.department}
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            {studentInfo.status === 'pending'
              ? '현재 편입연 관리자가 학번 및 학과/학부 정보를 확인 중입니다. 승인 완료 시 기본 [준회원] 등급으로 예약 시스템을 이용하실 수 있습니다.'
              : '가입 승인이 반려되었습니다. 편입연 관리자에게 문의해 주세요.'}
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full min-h-[46px] py-2.5 bg-slate-900 text-white text-xs font-bold rounded-xl"
          >
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      {/* 상단 헤더 */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-3.5 sm:px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h1 className="text-base sm:text-lg font-extrabold text-slate-900 truncate">
                편입연 공간 예약
              </h1>
              {studentInfo.isRegular ? (
                <span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 text-[11px] font-bold rounded-full flex items-center gap-1">
                  <UserCheck className="w-3 h-3" /> 정회원
                </span>
              ) : (
                <span className="px-2 py-0.5 bg-amber-100 text-amber-800 text-[11px] font-bold rounded-full">
                  준회원
                </span>
              )}
            </div>
            <p className="text-[11px] sm:text-xs text-slate-500 truncate mt-0.5">
              {studentInfo.name} · {studentInfo.studentId} ({studentInfo.department})
            </p>
          </div>

          <button
            onClick={handleLogout}
            className="min-h-[36px] px-3 py-1.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded-xl shrink-0"
          >
            로그아웃
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3.5 sm:px-4 mt-4 sm:mt-6 space-y-4 sm:space-y-6">
        {/* 1. 날짜 선택 & 이용 규칙 */}
        <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-emerald-600" /> 날짜 선택 (최대 7일 전)
            </h2>
            <button
              onClick={fetchScheduleAndReservations}
              className="min-h-[32px] px-2.5 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 rounded-lg flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 새로고침
            </button>
          </div>

          <div className="flex sm:grid sm:grid-cols-8 gap-2 overflow-x-auto pb-1 snap-x">
            {days.map((d) => {
              const active = d.dateStr === selectedDate;
              return (
                <button
                  key={d.dateStr}
                  onClick={() => setSelectedDate(d.dateStr)}
                  className={`snap-start min-w-[74px] sm:min-w-0 min-h-[52px] py-2 px-2.5 rounded-xl text-xs font-bold border transition flex flex-col items-center justify-center shrink-0 ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <span>{d.label}</span>
                  {d.isToday && (
                    <span
                      className={`text-[10px] mt-0.5 ${
                        active ? 'text-emerald-300' : 'text-emerald-600'
                      }`}
                    >
                      오늘
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div
            className={`mt-3.5 p-3.5 rounded-xl border ${
              currentMode === 'reading_room'
                ? 'bg-emerald-50/90 border-emerald-200 text-emerald-950'
                : 'bg-sky-50/90 border-sky-200 text-sky-950'
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs font-extrabold px-2.5 py-1 rounded-lg bg-white border border-current/15">
                {currentMode === 'reading_room' ? '열람실(시험기간) · 12석' : '스터디룸 · 전체 대관'}
              </span>
              <span className="text-xs font-extrabold">이용 규칙</span>
            </div>

            {currentMode === 'reading_room' ? (
              <ul className="text-xs font-medium space-y-1 leading-relaxed">
                <li>• 24시간 개방 (00:00 ~ 24:00) 및 1인 1좌석 예약</li>
                <li>• 준회원 일 최대 4시간 이용 가능 (정회원 제한 없음)</li>
                <li>• 예약 취소 시 취소한 본인만 10분간 동일 좌석 재예약 제한</li>
                <li>• 이용 시간 중 [퇴실하기] 버튼으로 조기 퇴실 가능</li>
              </ul>
            ) : (
              <ul className="text-xs font-medium space-y-1 leading-relaxed">
                <li>• 운영시간: 12시 ~ 22시 (최대 4시간 이용 가능)</li>
                <li>• 2인 이상 이용 필수 (대표자 및 동반자 중 정회원 1인 이상 필수)</li>
                <li>• 이용 시간 중 [퇴실하기] 버튼으로 조기 퇴실 가능</li>
              </ul>
            )}
          </div>
        </section>

        {/* 2. 열람실(시험기간) 좌석 배치도 (A와 B 사이만 떨어져 보이도록 구성) */}
        {currentMode === 'reading_room' && (
          <section className="bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-slate-800">
                열람실(시험기간) 좌석 배치도
              </h2>
              <span className="text-xs font-extrabold px-2.5 py-1 rounded-lg bg-slate-900 text-white">
                선택됨: {selectedSeat}
              </span>
            </div>

            <div
              className="overflow-x-auto overflow-y-hidden pb-6"
              style={{ touchAction: 'pan-x' }}
            >
              <div className="min-w-[660px] relative rounded-3xl border-[3px] border-stone-400 bg-stone-100/80 px-6 pt-5 pb-7">
                <div className="flex items-stretch justify-between gap-12">
                  {/* A 테이블 (단독 분리) */}
                  <div className="w-[180px] shrink-0 flex flex-col items-center">
                    <div className="flex items-center justify-center gap-2.5 mb-2">
                      {ROOM_TABLES[0].topSeats.map((seatId) => renderSeatButton(seatId, 'top'))}
                    </div>
                    <div className="w-full h-14 rounded-2xl bg-white border-2 border-stone-300 flex items-center justify-center">
                      <span className="text-sm font-extrabold text-stone-700">A 테이블</span>
                    </div>
                    <div className="flex items-center justify-center gap-2.5 mt-2">
                      {ROOM_TABLES[0].bottomSeats.map((seatId) => renderSeatButton(seatId, 'bottom'))}
                    </div>
                  </div>

                  {/* B + C 테이블 (A와는 넉넉히 떨어지고 B와 C는 나란히 붙어 배치) */}
                  <div className="flex-1 flex items-stretch gap-4">
                    <div className="flex-1 flex flex-col items-center">
                      <div className="flex items-center justify-center gap-2.5 mb-2">
                        {ROOM_TABLES[1].topSeats.map((seatId) => renderSeatButton(seatId, 'top'))}
                      </div>
                      <div className="w-full h-14 rounded-2xl bg-white border-2 border-stone-300 flex items-center justify-center">
                        <span className="text-sm font-extrabold text-stone-700">B 테이블</span>
                      </div>
                      <div className="flex items-center justify-center gap-2.5 mt-2">
                        {ROOM_TABLES[1].bottomSeats.map((seatId) => renderSeatButton(seatId, 'bottom'))}
                      </div>
                    </div>

                    <div className="flex-1 flex flex-col items-center">
                      <div className="flex items-center justify-center gap-2.5 mb-2">
                        {ROOM_TABLES[2].topSeats.map((seatId) => renderSeatButton(seatId, 'top'))}
                      </div>
                      <div className="w-full h-14 rounded-2xl bg-white border-2 border-stone-300 flex items-center justify-center">
                        <span className="text-sm font-extrabold text-stone-700">C 테이블</span>
                      </div>
                      <div className="flex items-center justify-center gap-2.5 mt-2">
                        {ROOM_TABLES[2].bottomSeats.map((seatId) => renderSeatButton(seatId, 'bottom'))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 왼쪽 하단 출입구 표시 */}
                <div className="absolute -bottom-6 left-11 flex flex-col items-center">
                  <div className="flex items-center gap-5 bg-stone-100 px-2.5">
                    <span className="w-1 h-3.5 bg-stone-500 rounded-full" />
                    <ArrowUp className="w-4 h-4 text-stone-600 stroke-[2.5]" />
                    <span className="w-1 h-3.5 bg-stone-500 rounded-full" />
                  </div>
                  <span className="text-[11px] font-extrabold text-stone-600">입구</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 3. 압축된 시간표 + [시작 시간 + 이용 시간] 선택 */}
        <section className="bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-200 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-emerald-600" />
              {currentMode === 'reading_room'
                ? `[${selectedSeat}] 시간 선택`
                : '[스터디룸] 12시 ~ 22시 시간 선택'}
            </h2>

            <div className="flex items-center gap-3 text-xs font-semibold">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-emerald-500 inline-block" /> 빈자리
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-gray-300 inline-block" /> 예약됨
              </span>
            </div>
          </div>

          <div className="p-3 sm:p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            {loadingData ? (
              <div className="h-12 rounded-xl bg-slate-200 animate-pulse" />
            ) : currentMode === 'reading_room' ? (
              <>
                {renderTimelineStrip({
                  titleBadge: '오전 (00시~12시)',
                  startHour: 0,
                  cols: 12,
                  blocks: amBlocks,
                })}
                {renderTimelineStrip({
                  titleBadge: '오후 (12시~24시)',
                  startHour: 12,
                  cols: 12,
                  blocks: pmBlocks,
                })}
              </>
            ) : (
              renderTimelineStrip({
                titleBadge: '이용 시간 (12시 ~ 22시)',
                startHour: 12,
                cols: 10,
                blocks: studyBlocks,
              })
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">1. 시작 시간</label>
              <select
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={availableStartSlots.length === 0}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm font-bold border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              >
                {availableStartSlots.length === 0 ? (
                  <option value="">예약 가능한 시작 시간 없음</option>
                ) : (
                  availableStartSlots.map((slot) => (
                    <option key={slot.start} value={slot.start}>
                      {slot.start} 시작
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">2. 이용 시간</label>
              <select
                value={durationSlots}
                onChange={(e) => setDurationSlots(Number(e.target.value))}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-base sm:text-sm font-bold border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              >
                {durationOptions.map((opt) => (
                  <option key={opt.slots} value={opt.slots}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* 4. 내 활성 예약 내역 */}
        <section className="bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-200">
          <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" /> 내 활성 예약 내역 ({myReservations.length}건)
          </h2>

          {myReservations.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">현재 예약된 내역이 없습니다.</p>
          ) : (
            <div className="space-y-3">
              {myReservations.map((res) => {
                const sHHMM = formatHHMM(res.start_time);
                const eHHMM = formatHHMM(res.end_time);
                const inProgress = isReservationInProgress(res.date, sHHMM, eHHMM);
                return (
                  <div
                    key={res.id}
                    className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold px-2 py-0.5 rounded bg-slate-800 text-white">
                          {res.mode === 'reading_room'
                            ? `열람실(시험기간) ${res.seat_id}`
                            : '스터디룸'}
                        </span>
                        <span className="text-sm font-extrabold text-slate-800">
                          {res.date} | {sHHMM} ~ {eHHMM}
                        </span>
                        {inProgress && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 animate-pulse">
                            예약 중
                          </span>
                        )}
                      </div>
                      {res.mode === 'study_room' && (
                        <p className="text-xs text-slate-500 mt-1">
                          인원: {res.total_headcount}명 · 목적: {res.purpose}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-end">
                      {inProgress ? (
                        <button
                          onClick={() => {
                            setActionPin('');
                            setActionError('');
                            setActionModal({ type: 'early_exit', reservation: res });
                          }}
                          className="w-full sm:w-auto min-h-[40px] px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                        >
                          <LogOut className="w-3.5 h-3.5" /> 퇴실하기
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setActionPin('');
                            setActionError('');
                            setActionModal({ type: 'cancel', reservation: res });
                          }}
                          className="w-full sm:w-auto min-h-[40px] px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1"
                        >
                          <XCircle className="w-3.5 h-3.5" /> 예약 취소
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* 하단 고정 예약 실행 바 */}
      <div className="fixed bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur border-t border-slate-800 text-white z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs sm:text-sm">
            <div className="font-extrabold text-emerald-400">
              {currentMode === 'reading_room' ? `좌석 ${selectedSeat}` : '스터디룸'}
            </div>
            {rangeValidation.valid ? (
              <div className="truncate text-slate-200">
                <strong>{startTime} ~ {computedEndTime}</strong> ({durationSlots * 0.5}시간)
              </div>
            ) : (
              <div className="truncate text-rose-300 font-semibold">{rangeValidation.reason}</div>
            )}
          </div>

          <button
            type="button"
            onClick={handleOpenBookingModal}
            disabled={!rangeValidation.valid}
            className={`min-h-[44px] px-5 py-2.5 text-sm font-bold rounded-xl shadow shrink-0 transition ${
              rangeValidation.valid
                ? 'bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white'
                : 'bg-slate-700 text-slate-400 cursor-not-allowed'
            }`}
          >
            예약 신청하기
          </button>
        </div>
      </div>

      {/* 예약 신청 모달 */}
      {showBookingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl max-w-md w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-extrabold text-slate-900 mb-1">
              {currentMode === 'reading_room'
                ? `열람실(시험기간) [${selectedSeat}] 예약`
                : '스터디룸 예약 신청'}
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {selectedDate} · {startTime} ~ {computedEndTime} (총 {durationSlots * 0.5}시간)
            </p>

            <form onSubmit={handleConfirmBooking} className="space-y-4">
              {currentMode === 'study_room' && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" /> 동반자 학번 추가(본인 제외)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={10}
                        placeholder="예: 2026170123"
                        value={companionInput}
                        onChange={(e) => setCompanionInput(e.target.value.replace(/[^0-9]/g, ''))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddCompanionId();
                          }
                        }}
                        className="flex-1 min-h-[44px] px-3 py-2 text-base sm:text-sm border border-slate-300 rounded-xl tracking-wider"
                      />
                      <button
                        type="button"
                        onClick={handleAddCompanionId}
                        className="min-h-[44px] px-4 py-2 text-xs font-bold bg-slate-800 hover:bg-slate-900 text-white rounded-xl shrink-0"
                      >
                        추가
                      </button>
                    </div>

                    {companionList.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {companionList.map((cid) => (
                          <span
                            key={cid}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-900"
                          >
                            <span>{cid}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCompanionId(cid)}
                              aria-label={`${cid} 삭제`}
                              className="text-emerald-700 hover:text-rose-600 text-sm font-extrabold leading-none px-0.5"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    <p className="text-[11px] text-slate-400 mt-1.5">
                      * 학번 10자리를 입력 후 [추가]를 누르면 아래에 표시되며, × 버튼으로 지울 수 있습니다.
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1.5">총 인원</label>
                      <input
                        type="number"
                        min={2}
                        max={20}
                        value={totalHeadcount}
                        onChange={(e) => setTotalHeadcount(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm border border-slate-300 rounded-xl"
                      />
                      <p className="text-[10px] text-slate-400 mt-1">
                        본인+동반자: {companionList.length + 1}명
                      </p>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs font-bold text-slate-700 mb-1.5">사용 목적</label>
                      <input
                        type="text"
                        placeholder="예: 전공 팀플, 스터디 회의"
                        value={purpose}
                        onChange={(e) => setPurpose(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5" /> 일회성 예약 비밀번호 (숫자 4자리)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  placeholder="숫자 4자리 (예: 1234)"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm border border-slate-300 rounded-xl tracking-widest"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  * 나중에 예약을 취소하거나 퇴실할 때 사용됩니다.
                </p>
              </div>

              {bookingError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
                  {bookingError}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBookingModal(false)}
                  className="flex-1 min-h-[46px] px-4 py-2.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl"
                >
                  닫기
                </button>
                <button
                  type="submit"
                  disabled={bookingSubmitting}
                  className="flex-[2] min-h-[46px] px-5 py-2.5 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                >
                  {bookingSubmitting ? '처리 중...' : '최종 예약 확정'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 취소 / 퇴실 모달 */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl max-w-sm w-full p-6 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900 mb-1">
              {actionModal.type === 'early_exit' ? '퇴실하기 (조기 종료)' : '예약 취소 확인'}
            </h3>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              {actionModal.type === 'early_exit'
                ? '지금 퇴실하시면 현재 30분 단위 시간 이후의 잔여 시간이 즉시 빈자리로 반환됩니다.'
                : actionModal.reservation?.mode === 'reading_room'
                ? '예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요. (취소 후 10분간 본인은 동일 좌석 재예약이 제한됩니다)'
                : '예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요.'}
            </p>

            <form onSubmit={handleExecuteAction} className="space-y-3">
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                placeholder="일회성 비밀번호 4자리"
                value={actionPin}
                onChange={(e) => setActionPin(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full min-h-[46px] px-3 py-2.5 text-base sm:text-sm border border-slate-300 rounded-xl text-center tracking-widest"
              />

              {actionError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
                  {actionError}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="flex-1 min-h-[44px] px-4 py-2 text-xs font-bold bg-slate-100 text-slate-700 rounded-xl"
                >
                  닫기
                </button>
                <button
                  type="submit"
                  disabled={actionSubmitting}
                  className="flex-[2] min-h-[44px] px-4 py-2 text-xs font-bold bg-slate-900 text-white rounded-xl"
                >
                  {actionSubmitting ? '확인 중...' : '확인'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}