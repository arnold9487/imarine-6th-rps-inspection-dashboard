# -*- coding: utf-8 -*-
r"""
階段一:用 best.pt 對 SeaFront 測試集(2,480 張)做推論,
把每一個「破損(cls=1)偵測框」的真實信心值抽出來,存成 damage_pool.json。

用途:動態風險巡檢決策儀表盤 —— D_score 裡每個壞櫃的 P_i,
      直接從這個真實信心池抽樣,而非手打。

輸出:巡檢決策儀表盤/data/damage_pool.json
      {
        meta:  { 統計數字,可放簡報 },
        pool:  [ 0.91, 0.83, ... ]        # 所有破損偵測的真實信心(供抽樣)
        per_image: [ {name, dmg:[...], n_container}, ... ]
      }
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

WEIGHTS = Path(r"c:\Users\Arnold_junyen\Documents\vscode工作區\imarine\辨識模型\訓練\runs\damage_yolo11s-2\weights\best.pt")
IMGS = Path(r"D:\Arnold_chun_yen\container_damage\dataset_test\images\test")
CONF = 0.25          # 標準偵測門檻:模型「確實判為破損」才計入
IMGSZ = 640
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def main():
    from ultralytics import YOLO

    model = YOLO(str(WEIGHTS))
    imgs = sorted(p for p in IMGS.iterdir() if p.suffix.lower() in IMG_EXT)
    print(f"測試影像:{len(imgs)} 張,開始推論(conf>={CONF})...")

    pool = []            # 所有破損偵測的信心值(扁平,供抽樣)
    per_image = []       # 逐圖明細
    n_with_damage = 0

    import torch
    for i, p in enumerate(imgs, 1):
        try:
            r = model.predict(str(p), conf=CONF, imgsz=IMGSZ, device=0, verbose=False)[0]
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            r = model.predict(str(p), conf=CONF, imgsz=IMGSZ, device="cpu", verbose=False)[0]
        if i % 200 == 0:
            torch.cuda.empty_cache()
        dmg, n_cont = [], 0
        for b in r.boxes:
            cls = int(b.cls[0]); cf = float(b.conf[0])
            if cls == 1:
                dmg.append(round(cf, 4))
            elif cls == 0:
                n_cont += 1
        if dmg:
            n_with_damage += 1
        pool.extend(dmg)
        per_image.append({"name": p.name, "dmg": dmg, "n_container": n_cont})
        if i % 400 == 0:
            print(f"  ...{i}/{len(imgs)}")

    pool_sorted = sorted(pool)
    n = len(pool_sorted)
    stats = {
        "n_images": len(imgs),
        "n_images_with_damage": n_with_damage,
        "frac_images_with_damage": round(n_with_damage / len(imgs), 4),
        "n_damage_detections": n,
        "conf_threshold": CONF,
        "mean_damage_conf": round(sum(pool) / n, 4) if n else 0.0,
        "median_damage_conf": pool_sorted[n // 2] if n else 0.0,
        "p10_damage_conf": pool_sorted[int(n * 0.10)] if n else 0.0,
        "p90_damage_conf": pool_sorted[int(n * 0.90)] if n else 0.0,
    }
    print("=== 統計 ===")
    print(json.dumps(stats, ensure_ascii=False, indent=2))

    out = OUT_DIR / "damage_pool.json"
    out.write_text(json.dumps(
        {"meta": stats, "pool": pool, "per_image": per_image},
        ensure_ascii=False), encoding="utf-8")
    print("已寫出:", out)


if __name__ == "__main__":
    main()
