#!/usr/bin/env python3
"""
VoxCPM2 Web Studio & Voice Cloning Playground
A standalone Gradio web interface to test, clone, and export custom voices
for use in Meatika AI Dubber Pro settings.

Usage:
  ./start-voxcpm-ui.sh
  OR
  python voxcpm_studio.py
"""

import os
import sys
import tempfile
import torch
import soundfile as sf
import gradio as gr

# Ensure Apple Silicon MPS optimizations if running on Mac
if sys.platform == "darwin":
    os.environ["VOXCPM_MPS_DTYPE"] = "float16"

print("[VoxCPM Studio] Initializing environment...")

# Determine hardware device
if torch.cuda.is_available():
    device = "cuda"
    device_desc = f"NVIDIA GPU ({torch.cuda.get_device_name(0)})"
elif torch.backends.mps.is_available():
    device = "mps"
    device_desc = "Apple Silicon GPU (MPS Metal Acceleration)"
else:
    device = "cpu"
    device_desc = "CPU"

print(f"[VoxCPM Studio] Target hardware: {device_desc}")

# Global model instance (lazy loaded)
_model = None


def get_model():
    global _model
    if _model is None:
        from voxcpm import VoxCPM
        print("[VoxCPM Studio] Loading 'openbmb/VoxCPM2' model weights...")
        _model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
        print("[VoxCPM Studio] ✅ Model loaded and ready!")
    return _model


# Sample reference text suggestions
DEFAULT_KHMER_SAMPLE = "ជំរាបសួរ! នេះជាសំឡេងគំរូដែលត្រូវបានបង្កើតឡើងដោយប្រព័ន្ធបញ្ញាសិប្បនិម្មិត VoxCPM2 សម្រាប់ស្ទូឌីយោបញ្ចូលសំឡេង។"
DEFAULT_ENG_SAMPLE = "Welcome to Meatika Studio Pro. This is a cloned voice sample generated with VoxCPM2."


def clone_voice(
    text_to_speak: str,
    reference_audio: str,
    reference_text: str,
    inference_steps: int,
    cfg_guidance: float,
):
    """Generate audio from text using optional reference voice cloning."""
    if not text_to_speak or not text_to_speak.strip():
        raise gr.Error("Please enter text for the AI to speak.")

    try:
        model = get_model()

        # Handle reference voice
        ref_wav_path = reference_audio if reference_audio and os.path.exists(reference_audio) else None
        ref_prompt_text = reference_text.strip() if reference_text and reference_text.strip() else None

        print(f"[VoxCPM Studio] Synthesizing: '{text_to_speak[:40]}...' (steps={inference_steps}, cfg={cfg_guidance})")

        # Configure VoxCPM2 parameters
        kwargs = {
            "text": text_to_speak.strip(),
            "inference_timesteps": int(inference_steps),
            "cfg_value": float(cfg_guidance),
        }

        if ref_wav_path:
            if ref_prompt_text:
                # Continuation / Co-speech cloning mode (requires both audio and transcript)
                kwargs["prompt_wav_path"] = ref_wav_path
                kwargs["prompt_text"] = ref_prompt_text
            else:
                # Zero-shot voice cloning mode (pure reference audio via ref_audio tokens in VoxCPM2)
                kwargs["reference_wav_path"] = ref_wav_path

        audio_arr = model.generate(**kwargs)

        # Save to temporary 48kHz WAV file for playback and download
        output_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="voxcpm_sample_")
        sf.write(output_file.name, audio_arr, 48000)

        duration_sec = len(audio_arr) / 48000.0
        return (
            output_file.name,
            output_file.name,
            f"✅ Generation successful! 48kHz WAV created ({duration_sec:.1f}s). Download the WAV file below and upload it to Studio Preferences > Voice Profiles.",
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise gr.Error(f"VoxCPM generation failed: {str(e)}")


def create_ui():
    with gr.Blocks(title="VoxCPM2 Voice Cloning Studio") as demo:
        gr.HTML(f"""
        <div style="background: linear-gradient(135deg, #1e1b4b 0%, #31104b 50%, #1e1b4b 100%); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 16px; padding: 24px; margin-bottom: 20px; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);">
            <div style="font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 6px;">🎙️ VoxCPM2 Voice Cloning & Sample Studio</div>
            <div style="font-size: 13px; color: #c4b5fd;">Generate studio-quality voice samples, clone custom character voices, and export to Meatika AI Dubber Pro</div>
            <div style="margin-top: 10px; font-size: 11px; color: #a78bfa; font-family: monospace;">
                ⚡ Hardware Engine: {device_desc}
            </div>
        </div>
        """)

        with gr.Row():
            with gr.Column(scale=5):
                gr.Markdown("### 1️⃣ Target Speech Text")
                text_input = gr.Textbox(
                    label="Text for AI to Speak (Khmer, English, Chinese, etc.)",
                    value=DEFAULT_KHMER_SAMPLE,
                    lines=3,
                    placeholder="Enter the sentence you want the cloned voice to speak...",
                )

                gr.Markdown("### 2️⃣ Reference Voice Audio (For Voice Cloning)")
                with gr.Group():
                    ref_audio_input = gr.Audio(
                        label="Upload Audio Sample or Record Microphone (3–10 seconds is optimal)",
                        type="filepath",
                        sources=["upload", "microphone"],
                    )
                    ref_text_input = gr.Textbox(
                        label="Reference Audio Transcript (Optional, leave blank if unknown)",
                        lines=1,
                        placeholder="Optional: What the speaker is saying in the sample clip...",
                    )

                with gr.Accordion("⚙️ Advanced Neural Settings", open=False):
                    steps_slider = gr.Slider(
                        minimum=5,
                        maximum=30,
                        value=15,
                        step=1,
                        label="Inference Steps (10 = Fast, 15 = Balanced, 25 = Studio HD)",
                    )
                    cfg_slider = gr.Slider(
                        minimum=1.0,
                        maximum=4.0,
                        value=2.0,
                        step=0.2,
                        label="CFG Guidance Scale (Default 2.0)",
                    )

                generate_btn = gr.Button("🚀 Generate & Clone Voice Sample", variant="primary", size="lg")

            with gr.Column(scale=5):
                gr.Markdown("### 3️⃣ Synthesized Audio Preview")
                output_audio = gr.Audio(label="Play Generated Voice (48kHz Studio Quality)", type="filepath")
                output_file = gr.File(label="📥 Download WAV File for Settings > Voice Profiles")
                status_text = gr.Markdown("Ready to generate audio.")

                gr.HTML("""
                <div style="background: #181a24; border: 1px solid #2d3348; border-radius: 12px; padding: 16px; margin-top: 16px; font-size: 12px; line-height: 1.6; color: #cbd5e1;">
                    <strong style="color: #a78bfa;">💡 How to use this voice in Meatika AI Dubber:</strong>
                    <ol style="margin: 8px 0 0 16px; padding: 0;">
                        <li>Click <strong>Generate & Clone Voice Sample</strong> on the left.</li>
                        <li>Listen to the preview above to verify the cloned voice acting.</li>
                        <li>Download the <strong>.wav</strong> file from the box above.</li>
                        <li>Open <strong>Meatika AI Dubber</strong> → Click <strong>Settings (⚙️)</strong> → Go to <strong>Voice Profiles</strong> → Click <strong>Add Custom Voice Profile</strong>.</li>
                        <li>Click <strong>Upload Audio File</strong> and select your downloaded WAV file!</li>
                    </ol>
                </div>
                """)

        # Wire click event
        generate_btn.click(
            fn=clone_voice,
            inputs=[text_input, ref_audio_input, ref_text_input, steps_slider, cfg_slider],
            outputs=[output_audio, output_file, status_text],
        )

        # Quick preset buttons
        gr.Markdown("#### 📝 Quick Presets")
        with gr.Row():
            gr.Button("🇰🇭 Khmer Intro").click(
                lambda: DEFAULT_KHMER_SAMPLE,
                outputs=[text_input],
            )
            gr.Button("🎬 Dramatic Movie Narration").click(
                lambda: "នៅក្នុងសម័យកាលដ៏យូរលង់ណាស់មកហើយ វីរបុរសម្នាក់បានក្រោកឈរឡើងដើម្បីការពារទឹកដី។",
                outputs=[text_input],
            )
            gr.Button("🌐 English Studio Voice").click(
                lambda: DEFAULT_ENG_SAMPLE,
                outputs=[text_input],
            )

    return demo


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    share = "--share" in sys.argv or os.environ.get("SHARE_GRADIO", "").lower() == "true"

    print(f"\n=======================================================")
    print(f"  🎙️ Launching VoxCPM2 Studio on http://localhost:{port}")
    if share:
        print(f"  🌐 Public share link will be created via Gradio Live")
    print(f"=======================================================\n")

    app = create_ui()
    try:
        app.launch(server_name="0.0.0.0", server_port=port, share=share)
    except OSError:
        fallback_port = 7861
        print(f"⚠️ Port {port} occupied, falling back to port {fallback_port}...")
        app.launch(server_name="0.0.0.0", server_port=fallback_port, share=share)
