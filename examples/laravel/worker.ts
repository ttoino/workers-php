import { ContainerProxy, phpWorker } from "workers-php";

export { AppContainer } from "./do";
export { ContainerProxy };

export default phpWorker({
    container: "CONTAINER",
    name: "app",
    storage: { bucket: "FILES", prefix: "/storage/" },
});
