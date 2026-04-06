/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, type ChangeEvent } from "react";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { Upload, Image as ImageIcon, Loader2, Wand2, Trash2, Download } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const SYSTEM_INSTRUCTION = `Role: 你是一個專業的電商產品影像處理專家。
Standard: 
1. 識別影像中的玻璃管產品。
2. 移除背景，僅保留產品主體（包含木頭蓋、玻璃管、內部的線香或產品標籤）。
3. 關鍵技術：必須保留玻璃管邊緣的透明感與光影反光，不可切除邊緣。
4. 如果使用者提供了「參考風格圖」，請將去背後的產品無縫嵌入該風格圖的場景中，並根據風格圖的燈光方向調整產品的陰影與色溫。

Scale & Proportion Protocol:
物理尺寸： 產品是一個小型線香管，真實尺寸為直徑 2.5cm、高度 12cm（約一支大鋼筆或小型手電筒的大小）。
比例控制： 在合成場景時，產品與環境比例必須維持真實。例如放置於桌面時，其高度應低於一般的咖啡杯，或約為書籍高度的一半。
景深表現： 由於產品體積小，合成時應伴隨明顯的淺景深（Bokeh），背景應有自然的模糊感，以符合微距或近距离攝影的視覺邏輯。`;

export default function App() {
  const [productImage, setProductImage] = useState<string | null>(null);
  const [styleImage, setStyleImage] = useState<string | null>(null);
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const productInputRef = useRef<HTMLInputElement>(null);
  const styleInputRef = useRef<HTMLInputElement>(null);

  const startCooldown = () => {
    setCooldown(60);
    const interval = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>, type: "product" | "style") => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      if (type === "product") setProductImage(base64);
      else setStyleImage(base64);
    };
    reader.readAsDataURL(file);
  };

  const resizeImage = (base64Str: string, maxWidth = 1536, maxHeight = 1536): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64Str;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
    });
  };

  const processImage = async () => {
    if (!productImage) return;

    setIsProcessing(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      // Resize images to prevent 500 errors from large payloads
      const resizedProduct = await resizeImage(productImage);
      const resizedStyle = styleImage ? await resizeImage(styleImage) : null;

      const productBase64 = resizedProduct.split(",")[1];
      const styleBase64 = resizedStyle?.split(",")[1];

      const parts = [
        {
          inlineData: {
            data: productBase64,
            mimeType: "image/jpeg",
          },
        },
      ];

      let prompt = "請依照系統標準，將這張圖中的玻璃管產品去背，輸出在純白背景上。";

      if (styleBase64) {
        parts.push({
          inlineData: {
            data: styleBase64,
            mimeType: "image/jpeg",
          },
        });
        prompt = "這張是產品（圖1），這張是參考風格（圖2）。請將產品去背後，參考圖2的構圖、光影與材質（例如：大理石桌面、禪意背景），生成一張全新的產品情境圖。";
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: {
          parts: [
            ...parts,
            { text: `${SYSTEM_INSTRUCTION}\n\n指令：${prompt}` }
          ],
        },
      });

      let foundImage = false;
      let aiTextResponse = "";
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          setResultImage(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
          foundImage = true;
          break;
        } else if (part.text) {
          aiTextResponse += part.text;
        }
      }

      if (!foundImage) {
        if (aiTextResponse) {
          throw new Error(`AI Refusal: ${aiTextResponse}`);
        }
        throw new Error("AI did not return an image. This might be due to a transient error or content safety filters. Please try again with a different image.");
      }
    } catch (err: any) {
      console.error("AI Error:", err);
      const errorMessage = err.message || String(err);
      
      if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
        setError("You've exceeded your current Gemini API quota. Please wait a minute before trying again, or check your API key's billing status in the Google AI Studio settings.");
        startCooldown();
      } else if (errorMessage.includes("500") || errorMessage.includes("INTERNAL")) {
        setError("The AI encountered an internal error. This often happens if the image is too complex or the service is temporarily overloaded. Please try again in a moment.");
      } else if (errorMessage.includes("AI Refusal:")) {
        setError(errorMessage);
      } else {
        setError(errorMessage || "An error occurred while processing the image.");
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadResult = () => {
    if (!resultImage) return;
    const link = document.createElement("a");
    link.href = resultImage;
    link.download = "processed-glass-tube.png";
    link.click();
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-neutral-200">
      {/* Header */}
      <header className="border-b border-neutral-200 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center">
              <Wand2 className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-semibold text-lg tracking-tight">Glass Tube Expert</h1>
          </div>
          <div className="text-xs font-mono text-neutral-400 uppercase tracking-widest">
            AI Image Processor
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
          
          {/* Left Column: Uploads */}
          <div className="lg:col-span-5 space-y-8">
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500">1. Product Image</h2>
                {productImage && (
                  <button 
                    onClick={() => setProductImage(null)}
                    className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                )}
              </div>
              
              <div 
                onClick={() => productInputRef.current?.click()}
                className={cn(
                  "relative aspect-square rounded-2xl border-2 border-dashed transition-all cursor-pointer group overflow-hidden",
                  productImage 
                    ? "border-neutral-200 bg-white" 
                    : "border-neutral-300 bg-neutral-100 hover:border-neutral-400 hover:bg-neutral-200"
                )}
              >
                <input 
                  type="file" 
                  ref={productInputRef} 
                  className="hidden" 
                  accept="image/*"
                  onChange={(e) => handleFileChange(e, "product")}
                />
                
                {productImage ? (
                  <img src={productImage} alt="Product" className="w-full h-full object-contain p-4" referrerPolicy="no-referrer" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                    <Upload className="w-8 h-8 text-neutral-400 mb-3 group-hover:scale-110 transition-transform" />
                    <p className="text-sm font-medium">Upload Product Image</p>
                    <p className="text-xs text-neutral-400 mt-1">Glass tube products recommended</p>
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500">2. Style Reference (Optional)</h2>
                {styleImage && (
                  <button 
                    onClick={() => setStyleImage(null)}
                    className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                )}
              </div>
              
              <div 
                onClick={() => styleInputRef.current?.click()}
                className={cn(
                  "relative aspect-video rounded-2xl border-2 border-dashed transition-all cursor-pointer group overflow-hidden",
                  styleImage 
                    ? "border-neutral-200 bg-white" 
                    : "border-neutral-300 bg-neutral-100 hover:border-neutral-400 hover:bg-neutral-200"
                )}
              >
                <input 
                  type="file" 
                  ref={styleInputRef} 
                  className="hidden" 
                  accept="image/*"
                  onChange={(e) => handleFileChange(e, "style")}
                />
                
                {styleImage ? (
                  <img src={styleImage} alt="Style" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                    <ImageIcon className="w-8 h-8 text-neutral-400 mb-3 group-hover:scale-110 transition-transform" />
                    <p className="text-sm font-medium">Upload Style Reference</p>
                    <p className="text-xs text-neutral-400 mt-1">Background, lighting, or context</p>
                  </div>
                )}
              </div>
            </section>

            <button
              disabled={!productImage || isProcessing || cooldown > 0}
              onClick={processImage}
              className={cn(
                "w-full py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 shadow-lg",
                !productImage || isProcessing || cooldown > 0
                  ? "bg-neutral-200 text-neutral-400 cursor-not-allowed shadow-none"
                  : "bg-neutral-900 text-white hover:bg-neutral-800 active:scale-[0.98]"
              )}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Processing...
                </>
              ) : cooldown > 0 ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Retry in {cooldown}s
                </>
              ) : (
                <>
                  <Wand2 className="w-5 h-5" />
                  {styleImage ? "Generate Composite" : "Remove Background"}
                </>
              )}
            </button>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm">
                {error}
                {cooldown > 0 && (
                  <p className="mt-2 text-xs opacity-80">
                    Note: Free-tier Gemini API keys have a rate limit for image generation. The button will re-enable automatically.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Right Column: Result */}
          <div className="lg:col-span-7">
            <div className="bg-white rounded-3xl border border-neutral-200 shadow-sm overflow-hidden h-full flex flex-col min-h-[500px]">
              <div className="p-6 border-b border-neutral-100 flex items-center justify-between bg-neutral-50/50">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500">Result</h2>
                {resultImage && (
                  <button 
                    onClick={downloadResult}
                    className="text-xs font-medium bg-white border border-neutral-200 px-3 py-1.5 rounded-lg hover:bg-neutral-50 transition-colors flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </button>
                )}
              </div>
              
              <div className="flex-1 flex items-center justify-center p-8 bg-[radial-gradient(#e5e5e5_1px,transparent_1px)] [background-size:20px_20px]">
                {resultImage ? (
                  <img 
                    src={resultImage} 
                    alt="Result" 
                    className="max-w-full max-h-full object-contain shadow-2xl rounded-lg" 
                    referrerPolicy="no-referrer"
                  />
                ) : isProcessing ? (
                  <div className="flex flex-col items-center gap-4 text-neutral-400">
                    <Loader2 className="w-12 h-12 animate-spin" />
                    <p className="text-sm animate-pulse">AI is crafting your image...</p>
                  </div>
                ) : (
                  <div className="text-center space-y-3 max-w-xs">
                    <div className="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto">
                      <ImageIcon className="w-8 h-8 text-neutral-300" />
                    </div>
                    <p className="text-sm text-neutral-400">
                      Upload a product image and click process to see the magic.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 py-8 border-t border-neutral-200 mt-12">
        <p className="text-xs text-neutral-400 text-center">
          Powered by Gemini 2.5 Flash Image • Professional E-commerce Solutions
        </p>
      </footer>
    </div>
  );
}
