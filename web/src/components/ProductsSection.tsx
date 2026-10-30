import { useRef, useState } from "react";
import type { FlowStatus, Product, Project } from "../../../shared/types";
import { api, fileUrl } from "../api";
import { Editable } from "./Editable";
import { isBusy, RenderLabel } from "./Busy";
import { StatusBadge } from "./StatusBadge";

interface Props {
  project: Project;
  flow: FlowStatus | null;
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
}

/**
 * Products shown in the video. Their photos are attached first whenever a scene with the product is rendered,
 * and a product-lock line keeps the packaging, label and logo exactly as photographed.
 */
export function ProductsSection({ project, flow, onChange, onError }: Props) {
  const id = project.id;
  const products = project.products ?? [];
  const run = (p: Promise<Project>) => p.then(onChange).catch((e) => onError(e.message));
  const ugc = project.settings.videoStyle === "ugc";

  return (
    <section className={`card products ${ugc ? "highlight" : ""}`}>
      <div className="card-head">
        <h3>Products</h3>
        <button className="btn small" onClick={() => run(api.addProduct(id))}>+ Add product</button>
      </div>
      <p className="muted small">
        Upload clear photos of the product (front label, packaging). They're attached first in every shot the product is
        in, and each prompt says to keep its packaging, colours, label text and logo exactly as photographed.
        <b> 🔒 Locked</b> products are in every scene; others only in the scenes you tick on the Storyboard.
      </p>
      {products.length === 0 && (
        <div className="empty small-empty">
          No products yet. {ugc ? "For a UGC ad, add the product you're selling first." : "Add one if the video shows a product."}
        </div>
      )}
      <div className="product-grid">
        {products.map((x) => (
          <ProductCard key={x.id} project={project} product={x} flow={flow} onChange={onChange} onError={onError} />
        ))}
      </div>
    </section>
  );
}

function ProductCard({ project, product: x, flow, onChange, onError }: {
  project: Project;
  product: Product;
  flow: FlowStatus | null;
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
}) {
  const id = project.id;
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const run = (p: Promise<Project>) => p.then(onChange).catch((e) => onError(e.message));
  const photos = project.references.filter((r) => x.referenceIds.includes(r.id));
  const loose = project.references.filter((r) => r.kind === "product" && !x.referenceIds.includes(r.id));
  const used = project.scenes.filter((s) => x.locked || s.productIds?.includes(x.id)).length;

  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setUploading(true);
    await run(api.uploadRefs(id, images, "product", undefined, x.id));
    setUploading(false);
  };
  const shot = () => {
    if (!flow?.signedIn) return onError("Connect Google Flow first (top right).");
    if (!photos.length) return onError("Add a photo of the product first.");
    api.render(id, "product", [x.id]).catch((e) => onError(e.message));
  };

  return (
    <div className="product">
      <div className="product-photos">
        {photos.map((r) => (
          <div key={r.id} className="product-photo">
            <img src={fileUrl(id, "refs", r.file)} alt={r.label} />
            <button className="icon-btn" title="Unlink this photo"
              onClick={() => run(api.updateProduct(id, x.id, { referenceIds: x.referenceIds.filter((y) => y !== r.id) }))}>×</button>
          </div>
        ))}
        {x.shotFile && (
          <div className="product-photo shot" title="Flow's product shot: check the label and logo came out right">
            <img src={fileUrl(id, "renders", x.shotFile)} alt="Product shot" />
            <span className="tag">Flow</span>
          </div>
        )}
        <button className="product-add" onClick={() => input.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "+ Photo"}
        </button>
        <input ref={input} type="file" accept="image/*" multiple hidden
          onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <StatusBadge status={x.shotStatus ?? "idle"} />
      </div>

      <div className="product-body">
        <div className="row tight">
          <Editable className="title-input" value={x.name} onSave={(name) => run(api.updateProduct(id, x.id, { name }))} />
          <button className={`chip lock ${x.locked ? "on" : ""}`} onClick={() => run(api.updateProduct(id, x.id, { locked: !x.locked }))}
            title={x.locked ? "Locked: in every scene. Click to choose scenes yourself." : "Click to put this product in every scene."}>
            {x.locked ? "🔒 In every scene" : "🔓 Chosen scenes"}
          </button>
        </div>
        <label className="field">
          <span>What it is</span>
          <Editable value={x.description} placeholder="e.g. Vitamin C brightening serum, 30 ml" onSave={(description) => run(api.updateProduct(id, x.id, { description }))} />
        </label>
        <label className="field">
          <span>Exact look (used in every prompt)</span>
          <Editable multiline rows={3} value={x.visualPrompt}
            placeholder="e.g. small amber glass dropper bottle with a white label, orange 'GLOW C' logo, gold cap"
            onSave={(visualPrompt) => run(api.updateProduct(id, x.id, { visualPrompt }))} />
        </label>
        {loose.length > 0 && (
          <div className="chips">
            <span className="muted small">Link a product photo:</span>
            {loose.map((r) => (
              <button key={r.id} className="chip" onClick={() => run(api.updateProduct(id, x.id, { referenceIds: [...x.referenceIds, r.id] }))}>
                <img src={fileUrl(id, "refs", r.file)} alt="" /> {r.label}
              </button>
            ))}
          </div>
        )}
        {x.error && <div className="error-text small">{x.error}</div>}
        <div className="row tight">
          <button className="btn small" onClick={shot} disabled={isBusy(x.shotStatus)}>
            <RenderLabel status={x.shotStatus} idle={x.shotFile ? "Re-render product shot" : "Render product shot"} running="Rendering product shot…" />
          </button>
          <span className="muted small">{used} scene{used === 1 ? "" : "s"}</span>
          <span className="grow" />
          <button className="btn small ghost danger" onClick={() => confirm(`Remove ${x.name}?`) && run(api.deleteProduct(id, x.id))}>Remove</button>
        </div>
      </div>
    </div>
  );
}
