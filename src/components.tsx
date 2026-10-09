import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Delete,
  Edit3,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { MeterRecord } from "./types";
import { getMeterPairStatus, isMeterPairComplete, type QrParseResult } from "./parser";
import { formatExpiryDate, formatServiceNumber } from "./ocr";
import { vibrate } from "./feedback";

export function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "email" | "search" | "url";
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        inputMode={props.inputMode}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

// ======================== 客製化大數字鍵盤 ========================

export function LargeKeypad(props: {
  value: string;
  prefix?: string;
  prefixEnabled?: boolean;
  maxLength?: number;
  activeLabel?: string;
  // 文字欄擴充鍵：full＝字母盤＋斜線（型式／檢驗），slash＝只要斜線（製造日期）
  extras?: "slash" | "full";
  onSwitchBack?: () => void;
  onChange: (val: string) => void;
  onClear: () => void;
}) {
  const { value, prefix, prefixEnabled, maxLength, activeLabel, extras, onSwitchBack, onChange, onClear } = props;

  const handleDigit = (digit: string) => {
    vibrate(15);
    if (maxLength !== undefined && value.length >= maxLength) {
      return;
    }
    onChange(value + digit);
  };

  const handleAlpha = (char: string) => {
    vibrate(15);
    if (maxLength !== undefined && value.length >= maxLength) {
      return;
    }
    onChange(value + char);
  };

  const handleBackspace = () => {
    vibrate(20);
    if (value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const handleApplyPrefix = () => {
    vibrate(30);
    if (prefix) {
      // 若目前為空或與前綴不同，直接填入前綴
      onChange(prefix);
    }
  };

  return (
    <div className="large-keypad">
      <div className="keypad-toolbar">
        {activeLabel ? (
          <span className="keypad-mode-tag">{activeLabel}</span>
        ) : null}
        {onSwitchBack ? (
          <button
            type="button"
            className="keypad-switch-btn"
            onClick={onSwitchBack}
          >
            完成切換回電號
          </button>
        ) : null}
        {!onSwitchBack && prefixEnabled && prefix ? (
          <button
            type="button"
            className="keypad-prefix-btn"
            onClick={handleApplyPrefix}
          >
            填入前綴 ({prefix})
          </button>
        ) : null}
        {extras === "slash" ? (
          <button
            type="button"
            className="keypad-prefix-btn"
            title="斜線（日期用）"
            onClick={() => handleAlpha("/")}
          >
            輸入斜線 /
          </button>
        ) : null}
      </div>

      {extras === "full" ? (
        <div className="keypad-alpha-grid" aria-label="字母盤">
          {"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => (
            <button
              key={letter}
              type="button"
              className="keypad-alpha-btn"
              onClick={() => handleAlpha(letter)}
            >
              {letter}
            </button>
          ))}
          <button
            type="button"
            className="keypad-alpha-btn slash-key"
            title="斜線"
            onClick={() => handleAlpha("/")}
          >
            /
          </button>
        </div>
      ) : null}

      <div className="keypad-grid">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((num) => (
          <button
            key={num}
            type="button"
            className="keypad-num-btn"
            onClick={() => handleDigit(num)}
          >
            {num}
          </button>
        ))}
        <button
          type="button"
          className="keypad-action-btn clear-btn"
          title="清除"
          onClick={() => {
            vibrate(30);
            onClear();
          }}
        >
          C
        </button>
        <button
          type="button"
          className="keypad-num-btn"
          onClick={() => handleDigit("0")}
        >
          0
        </button>
        <button
          type="button"
          className="keypad-action-btn backspace-btn"
          title="退格"
          onClick={handleBackspace}
        >
          <Delete size={22} />
        </button>
      </div>
    </div>
  );
}

// ======================== 卡片清單（詳細改由統一編輯抽屜處理） ========================

export function RecordCard(props: {
  record: MeterRecord;
  index: number;
  selectionMode: boolean;
  selected: boolean;
  seenQrTexts?: string[];
  onToggleSelection: (index: number) => void;
  onDelete: (index: number) => void;
  onEdit: (record: MeterRecord, index: number) => void;
  onQuickFillServiceNumber?: (record: MeterRecord) => void;
}) {
  const { record, index, selectionMode, selected, seenQrTexts, onToggleSelection, onDelete, onEdit, onQuickFillServiceNumber } = props;

  const hasServiceNumber = Boolean(record.serviceNumber && record.serviceNumber.trim());
  const cleanServiceNum = (record.serviceNumber ?? "").replace(/\D/g, "");
  const formattedServiceNum = formatServiceNumber(cleanServiceNum);

  return (
    <article className={`record-card-redesigned ${hasServiceNumber ? "complete" : "incomplete"}`}>
      <div className="card-top-row">
        {selectionMode ? (
          <input
            checked={selected}
            className="select-check"
            type="checkbox"
            onChange={() => onToggleSelection(index)}
          />
        ) : null}

        <div className="status-pill">
          {hasServiceNumber ? (
            <span className="badge-complete">
              <CheckCircle2 size={13} /> 完整 ({cleanServiceNum.length}碼)
            </span>
          ) : (
            <span className="badge-incomplete">
              <XCircle size={13} /> 缺電號
            </span>
          )}
        </div>

        <div className="card-main-title">
          <span className="meter-label">表號</span>
          <strong className="meter-value">{record.meterNumber || `第 ${index + 1} 筆`}</strong>
        </div>

        {!selectionMode ? (
          <>
            <button
              className="icon-button small"
              type="button"
              title="編輯此筆"
              onClick={() => onEdit(record, index)}
            >
              <Edit3 size={16} />
            </button>
            <button
              className="icon-button small delete-action"
              type="button"
              title="刪除此筆"
              onClick={() => onDelete(index)}
            >
              <Trash2 size={16} />
            </button>
          </>
        ) : null}
      </div>

      <div className="card-service-display">
        <span className="service-tag">電號</span>
        {hasServiceNumber ? (
          <span className="service-text">{formattedServiceNum}</span>
        ) : (
          <button
            type="button"
            className="quick-fill-btn"
            onClick={() => onQuickFillServiceNumber?.(record)}
          >
            <Edit3 size={15} /> 點此輸入電號 (手動)
          </button>
        )}
      </div>

      <div className="card-meta-chips">
        {!isMeterPairComplete(record, seenQrTexts) ? (
          <span className="meta-chip chip-unpaired">
            {getMeterPairStatus(record, seenQrTexts).label}
          </span>
        ) : null}
        <span className="meta-chip">
          <em>型式</em> {record.model || "—"}
        </span>
        <span className="meta-chip">
          <em>製造</em> {record.manufactureDate || "—"}
        </span>
        <span className="meta-chip">
          <em>檢驗</em> {record.inspectionNumber || "—"}
        </span>
        <span className="meta-chip">
          <em>檢定</em> {record.expiryDate || "—"}
        </span>
      </div>
    </article>
  );
}

export function ScanDebug(props: { lastQrText: string; parsed: QrParseResult | null }) {
  if (!props.lastQrText) {
    return null;
  }

  return (
    <div className="scan-debug">
      <div className="scan-debug-title">完整掃描內容</div>
      <pre>{props.lastQrText}</pre>
      <div className="scan-debug-grid">
        <span>檢驗號碼</span>
        <strong>{props.parsed?.partialRecord.inspectionNumber || "未判別"}</strong>
        <span>表號</span>
        <strong>{props.parsed?.partialRecord.meterNumber || "未判別"}</strong>
        <span>型式</span>
        <strong>{props.parsed?.partialRecord.model || "未判別"}</strong>
        <span>製造日期</span>
        <strong>{props.parsed?.partialRecord.manufactureDate || "未判別"}</strong>
      </div>
    </div>
  );
}

// ======================== 統一編輯抽屜（掃描補電號＋清單編輯共用） ========================
// 規則：所有欄位點選後由同一套大鍵盤輸入（數字欄＋字母盤＋斜線），免呼叫原生鍵盤；
// 全域 keypadMode === "system" 時改用系統輸入框（設定頁切換）。

export type SheetNumericField = "serviceNumber" | "meterNumber" | "expiryDate" | "prefix";
export type SheetTextField = "model" | "manufactureDate" | "inspectionNumber";
export type SheetField = SheetNumericField | SheetTextField;
export type SheetEditableField = SheetField;

export function RecordEditSheet(props: {
  title: string;
  seenQrTexts?: string[];
  serviceNumber: string;
  model: string;
  meterNumber: string;
  manufactureDate: string;
  inspectionNumber: string;
  expiryDate: string;
  prefix: string;
  prefixEnabled: boolean;
  keypadMode: "large" | "system";
  error: string;
  initialFocus?: SheetNumericField;
  // 掃過的型式（近→遠，最多 8 個）：型式欄一點即填，不用拼字母
  modelOptions?: string[];
  actions: ReactNode;
  onField: (field: SheetEditableField, value: string) => void;
  onPrefixEnabledChange: (enabled: boolean) => void;
  onDismiss: () => void;
}) {
  const {
    title,
    seenQrTexts,
    serviceNumber,
    model,
    meterNumber,
    manufactureDate,
    inspectionNumber,
    expiryDate,
    prefix,
    prefixEnabled,
    keypadMode,
    error,
    initialFocus = "serviceNumber",
    modelOptions,
    actions,
    onField,
    onPrefixEnabledChange,
    onDismiss,
  } = props;
  const [activeField, setActiveField] = useState<SheetField>(initialFocus);
  // 點哪個欄位就把該列捲進可視區（解決按鈕列高低不同造成的半遮）
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fieldRefs = useRef(new Map<SheetField, HTMLDivElement>());

  function trackField(field: SheetField) {
    return (el: HTMLDivElement | null) => {
      if (el) {
        fieldRefs.current.set(field, el);
      } else {
        fieldRefs.current.delete(field);
      }
    };
  }

  useEffect(() => {
    const container = scrollRef.current;
    const target = fieldRefs.current.get(activeField);
    if (!container || !target) {
      return;
    }
    const top = target.offsetTop - container.offsetTop;
    const bottom = top + target.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (top < viewTop) {
      container.scrollTop = top - 4;
    } else if (bottom > viewBottom) {
      container.scrollTop = bottom - container.clientHeight + 4;
    }
  }, [activeField]);

  const useLargeKeypad = keypadMode === "large";
  const cleanService = (serviceNumber ?? "").replace(/\D/g, "").slice(0, 8);
  const cleanMeter = (meterNumber ?? "").replace(/\D/g, "");
  const cleanPrefix = (prefix ?? "").replace(/\D/g, "");
  const cleanExpiryDigits = (expiryDate ?? "").replace(/\D/g, "");

  const pairStatus = getMeterPairStatus(
    {
      meterNumber: cleanMeter,
      model,
      manufactureDate,
      inspectionNumber,
    },
    seenQrTexts,
  );

  function activate(field: SheetField) {
    setActiveField(field);
  }

  function handleKeypadChange(field: SheetField, val: string) {
    if (field === "expiryDate") {
      const digits = val.replace(/\D/g, "").slice(0, 5);
      onField("expiryDate", formatExpiryDate(digits));
      if (digits.length >= 5) {
        vibrate(30);
        setActiveField("serviceNumber");
      }
      return;
    }
    if (field === "model") {
      onField("model", val.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
      return;
    }
    if (field === "manufactureDate") {
      onField("manufactureDate", val.replace(/[^0-9/]/g, "").slice(0, 6));
      return;
    }
    if (field === "inspectionNumber") {
      onField("inspectionNumber", val.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12));
      return;
    }
    if (field === "serviceNumber" || field === "meterNumber") {
      onField(field, val.replace(/\D/g, "").slice(0, 8));
      return;
    }
    if (field === "prefix") {
      onField("prefix", val.replace(/\D/g, "").slice(0, 6));
      return;
    }
    onField(field, val.replace(/\D/g, ""));
  }

  const keypadValue =
    activeField === "serviceNumber"
      ? cleanService
      : activeField === "meterNumber"
        ? cleanMeter
        : activeField === "expiryDate"
          ? cleanExpiryDigits
          : activeField === "prefix"
            ? cleanPrefix
            : activeField === "model"
              ? model
              : activeField === "manufactureDate"
                ? manufactureDate
                : inspectionNumber;
  const keypadMaxLength =
    activeField === "serviceNumber"
      ? 8
      : activeField === "meterNumber"
        ? 8
        : activeField === "expiryDate"
          ? 5
          : activeField === "prefix"
            ? 6
            : activeField === "model"
              ? 6
              : activeField === "manufactureDate"
                ? 6
                : 12;
  const keypadLabel =
    activeField === "serviceNumber"
      ? "正在輸入「電號」（固定 8 碼）"
      : activeField === "meterNumber"
        ? "正在輸入「表號」（固定 8 碼）"
        : activeField === "expiryDate"
          ? "正在輸入「檢定期限」（5碼，例: 12512 → 125/12）"
          : activeField === "prefix"
            ? "正在輸入「電號前綴」"
            : activeField === "model"
              ? "正在輸入「型式」（英文字母）"
              : activeField === "manufactureDate"
                ? "正在輸入「製造日期」（例: 114/07）"
                : "正在輸入「檢驗號碼」（英文＋數字）";
  const keypadExtras =
    activeField === "model" || activeField === "inspectionNumber"
      ? "full"
      : activeField === "manufactureDate"
        ? "slash"
        : undefined;

  return (
    <div className="completion-overlay">
      <section className="completion-dialog compact-view" role="dialog" aria-modal="true" aria-labelledby="completion-title">
        <div className="completion-dialog-head compact">
          <div className="head-title-wrap">
            <h2 id="completion-title">{title}</h2>
            {!pairStatus.isComplete ? (
              <span className="completion-check compact pair-partial">
                {pairStatus.label}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="dialog-close-btn"
            title="關閉"
            onClick={onDismiss}
          >
            <X size={20} />
          </button>
        </div>

        {/* 欄位區獨立捲動：鍵盤＋按鈕固定在抽屜底部，不會被推出視窗 */}
        <div className="completion-scroll" ref={scrollRef}>
        <div className="completion-summary-compact">
          <span className="summary-pill">
            <em>表號</em> <strong>{cleanMeter || "未判別"}</strong>
          </span>
          <span className={`summary-pill ${!model ? "missing" : ""}`}>
            <em>型式</em> <strong>{model || "—"}</strong>
          </span>
          <span className={`summary-pill ${!manufactureDate ? "missing" : ""}`}>
            <em>製造</em> <strong>{manufactureDate || "—"}</strong>
          </span>
          <span className={`summary-pill ${!inspectionNumber ? "missing" : ""}`}>
            <em>檢驗</em> <strong>{inspectionNumber || "—"}</strong>
          </span>
        </div>

        <SheetNumberBox
          label="電號"
          wrapRef={trackField("serviceNumber")}
          active={useLargeKeypad && activeField === "serviceNumber"}
          useLarge={useLargeKeypad}
          value={cleanService}
          placeholder="點擊下方數字鍵盤輸入 (固定 8 碼)"
          display={cleanService}
          badge={`${cleanService.length} / 8 碼 ${cleanService.length === 8 ? "✓" : ""}`}
          badgeValid={cleanService.length === 8}
          onActivate={() => activate("serviceNumber")}
          onSystemChange={(val) => onField("serviceNumber", val.replace(/\D/g, "").slice(0, 8))}
          onClear={() => onField("serviceNumber", "")}
        />

        <SheetNumberBox
          label="表號"
          wrapRef={trackField("meterNumber")}
          active={useLargeKeypad && activeField === "meterNumber"}
          useLarge={useLargeKeypad}
          value={cleanMeter}
          placeholder="點擊下方數字鍵盤輸入表號 (固定 8 碼)"
          display={cleanMeter}
          badge={`${cleanMeter.length} / 8 碼 ${cleanMeter.length === 8 ? "✓" : ""}`}
          badgeValid={cleanMeter.length === 8}
          onActivate={() => activate("meterNumber")}
          onSystemChange={(val) => onField("meterNumber", val.replace(/\D/g, "").slice(0, 8))}
          onClear={() => onField("meterNumber", "")}
        />

        <SheetNumberBox
          label="型式"
          wrapRef={trackField("model")}
          active={useLargeKeypad && activeField === "model"}
          useLarge={useLargeKeypad}
          value={model}
          placeholder="點下方字母鍵盤輸入型式"
          display={model}
          badge={model ? `${model.length} 碼 ✓` : "未填"}
          badgeValid={Boolean(model)}
          inputMode="text"
          onActivate={() => activate("model")}
          onSystemChange={(val) => onField("model", val)}
          onClear={() => onField("model", "")}
        />

        <SheetNumberBox
          label="製造日期"
          wrapRef={trackField("manufactureDate")}
          active={useLargeKeypad && activeField === "manufactureDate"}
          useLarge={useLargeKeypad}
          value={manufactureDate}
          placeholder="點下方鍵盤輸入 (例: 114/07)"
          display={manufactureDate}
          badge={manufactureDate ? (/\d{2,3}\/\d{1,2}/.test(manufactureDate) ? "格式✓" : `${manufactureDate.length} 碼`) : "未填"}
          badgeValid={/\d{2,3}\/\d{1,2}/.test(manufactureDate)}
          inputMode="text"
          onActivate={() => activate("manufactureDate")}
          onSystemChange={(val) => onField("manufactureDate", val)}
          onClear={() => onField("manufactureDate", "")}
        />

        <SheetNumberBox
          label="檢驗號碼"
          wrapRef={trackField("inspectionNumber")}
          active={useLargeKeypad && activeField === "inspectionNumber"}
          useLarge={useLargeKeypad}
          value={inspectionNumber}
          placeholder="點下方字母鍵盤輸入檢驗號碼"
          display={inspectionNumber}
          badge={inspectionNumber ? `${inspectionNumber.length} 碼 ✓` : "未填"}
          badgeValid={Boolean(inspectionNumber)}
          inputMode="text"
          onActivate={() => activate("inspectionNumber")}
          onSystemChange={(val) => onField("inspectionNumber", val)}
          onClear={() => onField("inspectionNumber", "")}
        />

        <div
          ref={trackField("expiryDate")}
          className={`dialog-expiry-strip ${useLargeKeypad && activeField === "expiryDate" ? "active-focus" : ""} ${!expiryDate ? "needs-expiry" : "has-expiry"}`}
          onClick={() => {
            if (useLargeKeypad) {
              activate("expiryDate");
            }
          }}
        >
          <div className="expiry-strip-left">
            <span className="expiry-tag">檢定期限</span>
            {model ? (
              <span className="expiry-model-badge">型式 {model}</span>
            ) : null}
          </div>

          <div className="expiry-strip-val-wrap">
            {useLargeKeypad ? (
              <span className="expiry-strip-val">
                {expiryDate || <span className="expiry-placeholder">點此輸入 (如 12512)</span>}
              </span>
            ) : (
              <div className="input-with-clear-wrap" onClick={(e) => e.stopPropagation()}>
                <input
                  className="expiry-system-input"
                  inputMode="numeric"
                  placeholder="輸入如 12512"
                  value={expiryDate}
                  onChange={(e) => onField("expiryDate", formatExpiryDate(e.target.value))}
                />
                {expiryDate ? (
                  <button
                    type="button"
                    className="input-inline-clear-btn"
                    title="清空期限"
                    onClick={(e) => {
                      e.stopPropagation();
                      onField("expiryDate", "");
                    }}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            )}
          </div>

          <div className="expiry-strip-status">
            {expiryDate ? (
              <div className="expiry-status-row">
                <span className="expiry-ok">同型式已套用 ✓</span>
                <button
                  type="button"
                  className="strip-clear-btn"
                  title="清除期限"
                  onClick={(e) => {
                    e.stopPropagation();
                    vibrate(20);
                    onField("expiryDate", "");
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <span className="expiry-warn">首次需輸入 (同型式記憶)</span>
            )}
          </div>
        </div>

        <div className="prefix-controls-compact" ref={trackField("prefix")}>
          <label className="toggle-row compact">
            <input
              checked={prefixEnabled}
              type="checkbox"
              onChange={(event) => onPrefixEnabledChange(event.target.checked)}
            />
            <span>前綴</span>
          </label>

          {prefixEnabled ? (
            useLargeKeypad ? (
              <button
                type="button"
                className={`prefix-input-inline compact prefix-tap-display ${activeField === "prefix" ? "active-focus" : ""}`}
                onClick={() => activate("prefix")}
              >
                {cleanPrefix || <span className="prefix-placeholder">點鍵盤輸入</span>}
              </button>
            ) : (
              <div className="input-with-clear-wrap prefix-wrap">
                <input
                  className="prefix-input-inline compact"
                  inputMode="numeric"
                  placeholder="前綴數字"
                  value={prefix}
                  onChange={(event) => onField("prefix", event.target.value.replace(/\D/g, ""))}
                />
                {prefix ? (
                  <button
                    type="button"
                    className="input-inline-clear-btn"
                    title="清空前綴"
                    onClick={(e) => {
                      e.stopPropagation();
                      onField("prefix", "");
                    }}
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </div>
            )
          ) : null}
        </div>
        </div>
        {/* ↑ .completion-scroll 結束：以下鍵盤＋按鈕固定置底 */}

        {useLargeKeypad && activeField === "model" && modelOptions && modelOptions.length > 0 ? (
          <div className="keypad-model-chips" aria-label="歷史型式快選">
            {modelOptions.map((option) => (
              <button
                key={option}
                type="button"
                className="keypad-model-chip"
                onClick={() => {
                  vibrate(20);
                  onField("model", option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {useLargeKeypad ? (
          <LargeKeypad
            value={keypadValue}
            maxLength={keypadMaxLength}
            prefix={activeField === "serviceNumber" ? cleanPrefix : undefined}
            prefixEnabled={activeField === "serviceNumber" ? prefixEnabled : undefined}
            activeLabel={keypadLabel}
            extras={keypadExtras}
            onSwitchBack={activeField === "expiryDate" ? () => setActiveField("serviceNumber") : undefined}
            onChange={(val) => handleKeypadChange(activeField, val)}
            onClear={() => handleKeypadChange(activeField, "")}
          />
        ) : null}

        {error ? <p className="completion-error">{error}</p> : null}

        <div className="completion-actions-compact">
          {actions}
        </div>
      </section>
    </div>
  );
}

function SheetNumberBox(props: {
  label: string;
  active: boolean;
  useLarge: boolean;
  value: string;
  placeholder: string;
  display: ReactNode;
  badge: string;
  badgeValid: boolean;
  inputMode?: "numeric" | "text";
  wrapRef?: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
  onSystemChange: (val: string) => void;
  onClear: () => void;
}) {
  const { label, active, useLarge, value, placeholder, display, badge, badgeValid, inputMode = "numeric", wrapRef, onActivate, onSystemChange, onClear } = props;

  return (
    <div
      ref={wrapRef}
      className={`service-number-box-compact manual-only ${active ? "active-focus" : ""}`}
      onClick={() => {
        if (useLarge) {
          onActivate();
        }
      }}
    >
      <div className="display-top">
        <span className="display-label">{label}</span>
        <div className="display-top-right">
          <span className={`length-badge ${badgeValid ? "valid" : ""}`}>
            {badge}
          </span>
          {value ? (
            <button
              type="button"
              className="clear-text-btn"
              title={`一鍵清空${label}`}
              onClick={(e) => {
                e.stopPropagation();
                vibrate(20);
                onClear();
              }}
            >
              <X size={13} /> 清空
            </button>
          ) : null}
        </div>
      </div>

      {useLarge ? (
        <div className="service-big-display compact">
          {display || <span className="placeholder-text">{placeholder}</span>}
        </div>
      ) : (
        <div className="input-with-clear-wrap" onClick={(e) => e.stopPropagation()}>
          <input
            className="service-system-input"
            inputMode={inputMode}
            pattern={inputMode === "numeric" ? "[0-9]*" : undefined}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onSystemChange(e.target.value)}
          />
          {value ? (
            <button
              type="button"
              className="input-inline-clear-btn"
              title={`清空${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
