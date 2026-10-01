import { PhpOutbound, phpWorker } from "workers-php";

export { AppContainer } from "./do";
export { PhpOutbound };

export default phpWorker({
    container: "CONTAINER",
    name: "app",
    storage: { bucket: "FILES", prefix: "/storage/" },
});
