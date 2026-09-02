import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import browserRouter from "./browser";
import publishRouter from "./publish";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(browserRouter);
router.use(publishRouter);

export default router;
