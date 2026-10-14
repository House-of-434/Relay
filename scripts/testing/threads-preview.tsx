import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone, tourStorage, writeTourSeen } from "../../src/lib/first-run";
import { TOUR_STEPS } from "../../src/lib/guided-tour";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
if (!new URLSearchParams(location.search).has("onboarding")) {
  setEmailGateDone("skipped");
  // Skipping the gate marks the welcome done, which is exactly what opens
  // the guided tour — so mark every tour step seen too. The launcher drives
  // the shipping UI, not the tour.
  for (const step of TOUR_STEPS) writeTourSeen(tourStorage(), step.id);
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
