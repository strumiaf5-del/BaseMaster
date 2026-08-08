from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse


def create_jobs_router(*, jobs, sanitize_track_name) -> APIRouter:
    router = APIRouter()

    @router.get("/job/{job_id}", tags=["Jobs"])
    def get_job(job_id: str):
        if not jobs.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = jobs.get_job(job_id).copy()
        if job.get("type") == "stems":
            if job["status"] == "done":
                job["stem_download_urls"] = {
                    name: f"/stems/download/{job_id}/{name}" for name in job.get("available_stems", [])
                }
            job.pop("stem_paths", None)
            return job
        if job["status"] == "done":
            job["download_url"] = f"/download/{job_id}"
            job["report_url"] = f"/report/{job_id}"
            job["analysis_before"] = job["result"].get("analysis_before")
            job["analysis_after"] = job["result"].get("analysis_after")
            job["mix_advice_before"] = job["result"].get("mix_advice_before")
            job["mix_advice_after"] = job["result"].get("mix_advice_after")
            job["recommendations_before"] = job["result"].get("recommendations_before")
            job["recommendations_after"] = job["result"].get("recommendations_after")
            job["chain_meters"] = job["result"].get("chain_meters", {})
            job["output_bit_depth"] = job["result"].get("output_bit_depth")
            if "reference_match" in job["result"]:
                job["reference_match"] = job["result"]["reference_match"]
                job["analysis_reference"] = job["result"]["analysis_reference"]
            del job["result"]
        return job

    @router.get("/download/{job_id}", tags=["Jobs"])
    def download(job_id: str, name: Optional[str] = Query(None, description="Nombre del tema para el archivo descargado")):
        if not jobs.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = jobs.get_job(job_id)
        if job["status"] != "done":
            raise HTTPException(400, f"Job no listo: {job['status']}")
        output_path = job["result"]["output_path"]
        if not os.path.exists(output_path):
            raise HTTPException(410, "Archivo expirado. Volvé a masterizar.")
        fmt = job.get("params", {}).get("output_format", "wav")
        mt = "audio/mpeg" if fmt == "mp3" else ("audio/flac" if fmt == "flac" else "audio/wav")
        track_name = sanitize_track_name(name)
        return FileResponse(output_path, media_type=mt, filename=f"{track_name}.{fmt}")

    @router.get("/report/{job_id}", tags=["Jobs"])
    def export_report(job_id: str):
        if not jobs.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = jobs.get_job(job_id)
        if job["status"] != "done":
            raise HTTPException(400, f"Job no listo: {job['status']}")
        report = {
            "job_id": job_id,
            "filename": job["filename"],
            "created_at": job["created_at"],
            "finished_at": job.get("finished_at"),
            "params": job["params"],
            "analysis_before": job["result"]["analysis_before"],
            "analysis_after": job["result"]["analysis_after"],
            "mix_advice_before": job["result"]["mix_advice_before"],
            "mix_advice_after": job["result"]["mix_advice_after"],
            "recommendations_before": job["result"].get("recommendations_before"),
            "recommendations_after": job["result"].get("recommendations_after"),
            "chain_meters": job["result"].get("chain_meters", {}),
        }
        if "reference_match" in job["result"]:
            report["reference_match"] = job["result"]["reference_match"]
            report["analysis_reference"] = job["result"]["analysis_reference"]
        return JSONResponse(content=report, headers={
            "Content-Disposition": f'attachment; filename="mastering_report_{job_id[:8]}.json"'
        })

    @router.get("/jobs", tags=["Jobs"])
    def list_jobs():
        return [
            {"job_id": k, "status": v["status"], "filename": v["filename"], "created_at": v["created_at"]}
            for k, v in jobs.get_all().items()
        ]

    return router
